"use server";

import { auth } from "@clerk/nextjs/server";
import { db } from "@/lib/prisma";
import { revalidatePath } from "next/cache";
import { GoogleGenerativeAI } from "@google/generative-ai";
import aj from "@/lib/arcjet";
import { request } from "@arcjet/next";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const serializeAmount = (obj) => ({
  ...obj,
  amount: obj.amount.toNumber(),
});

// Create Transaction
export async function createTransaction(data) {
  try {
    console.log("Creating transaction with data:", {
      type: data?.type,
      amount: data?.amount,
      accountId: data?.accountId,
      hasDescription: !!data?.description,
      isRecurring: data?.isRecurring,
    });

    // Validate input data
    if (!data) {
      throw new Error("Transaction data is required");
    }

    if (!data.type || !data.amount || !data.accountId) {
      throw new Error("Missing required fields: type, amount, or accountId");
    }

    if (typeof data.amount !== "number" || data.amount <= 0) {
      throw new Error("Amount must be a positive number");
    }

    if (!["EXPENSE", "INCOME"].includes(data.type)) {
      throw new Error("Invalid transaction type");
    }

    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized - No userId");

    // Get request data for ArcJet
    let req;
    try {
      req = await request();
    } catch (arcjetErr) {
      console.warn("ArcJet request failed, continuing without rate limit check:", arcjetErr.message);
      req = null;
    }

    // Check rate limit (skip if req is unavailable)
    if (req) {
      const decision = await aj.protect(req, {
        userId,
        requested: 1,
      });

      if (decision.isDenied()) {
        if (decision.reason.isRateLimit()) {
          const { remaining, reset } = decision.reason;
          throw new Error(`Too many requests. Please try again in ${reset} seconds.`);
        }
        throw new Error("Request blocked by security policy");
      }
    }

    // Find user
    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found in database");
    }

    // Find account and verify ownership
    const account = await db.account.findUnique({
      where: {
        id: data.accountId,
      },
    });

    if (!account) {
      throw new Error("Account not found");
    }

    if (account.userId !== user.id) {
      throw new Error("You don't have permission to use this account");
    }

    // Calculate new balance
    const balanceChange = data.type === "EXPENSE" ? -data.amount : data.amount;
    const newBalance = account.balance.toNumber() + balanceChange;

    // Validate date
    const transactionDate = data.date ? new Date(data.date) : new Date();
    if (isNaN(transactionDate.getTime())) {
      throw new Error("Invalid transaction date");
    }

    // Create transaction and update account balance atomically
    const transaction = await db.$transaction(async (tx) => {
      const newTransaction = await tx.transaction.create({
        data: {
          type: data.type,
          amount: data.amount,
          description: data.description || "",
          date: transactionDate,
          category: data.category || "other",
          receiptUrl: data.receiptUrl || null,
          isRecurring: data.isRecurring || false,
          recurringInterval: data.recurringInterval || null,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(transactionDate, data.recurringInterval)
              : null,
          userId: user.id,
          accountId: data.accountId,
          status: "COMPLETED",
        },
      });

      await tx.account.update({
        where: { id: data.accountId },
        data: { balance: newBalance },
      });

      return newTransaction;
    });

    console.log("Transaction created successfully:", transaction.id);

    try {
      revalidatePath("/dashboard");
      revalidatePath(`/account/${transaction.accountId}`);
    } catch (revalidateErr) {
      console.warn("Cache revalidation failed:", revalidateErr.message);
    }

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    const errorMessage = error?.message || "Failed to create transaction";
    console.error("Transaction creation error:", {
      message: errorMessage,
      stack: error?.stack,
    });
    throw new Error(errorMessage);
  }
}

export async function getTransaction(id) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  const user = await db.user.findUnique({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  const transaction = await db.transaction.findUnique({
    where: {
      id,
      userId: user.id,
    },
  });

  if (!transaction) throw new Error("Transaction not found");

  return serializeAmount(transaction);
}

export async function updateTransaction(id, data) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    // Get original transaction to calculate balance change
    const originalTransaction = await db.transaction.findUnique({
      where: {
        id,
        userId: user.id,
      },
      include: {
        account: true,
      },
    });

    if (!originalTransaction) throw new Error("Transaction not found");

    // Calculate balance changes
    const oldBalanceChange =
      originalTransaction.type === "EXPENSE"
        ? -originalTransaction.amount.toNumber()
        : originalTransaction.amount.toNumber();

    const newBalanceChange =
      data.type === "EXPENSE" ? -data.amount : data.amount;

    const netBalanceChange = newBalanceChange - oldBalanceChange;

    // Update transaction and account balance in a transaction
    const transaction = await db.$transaction(async (tx) => {
      const updated = await tx.transaction.update({
        where: {
          id,
          userId: user.id,
        },
        data: {
          ...data,
          nextRecurringDate:
            data.isRecurring && data.recurringInterval
              ? calculateNextRecurringDate(data.date, data.recurringInterval)
              : null,
        },
      });

      // Update account balance
      await tx.account.update({
        where: { id: data.accountId },
        data: {
          balance: {
            increment: netBalanceChange,
          },
        },
      });

      return updated;
    });

    revalidatePath("/dashboard");
    revalidatePath(`/account/${data.accountId}`);

    return { success: true, data: serializeAmount(transaction) };
  } catch (error) {
    throw new Error(error.message);
  }
}

// Get User Transactions
export async function getUserTransactions(query = {}) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findUnique({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    const transactions = await db.transaction.findMany({
      where: {
        userId: user.id,
        ...query,
      },
      include: {
        account: true,
      },
      orderBy: {
        date: "desc",
      },
    });

    return { success: true, data: transactions };
  } catch (error) {
    throw new Error(error.message);
  }
}

// Scan Receipt
export async function scanReceipt(file) {
  try {
    if (!file) {
      throw new Error("No file provided");
    }

    if (!process.env.GEMINI_API_KEY) {
      throw new Error("GEMINI_API_KEY is not configured");
    }

    // Try gemini-2.0-flash first, fall back to gemini-pro-vision
    let model;
    try {
      model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    } catch (err) {
      console.warn("gemini-2.0-flash not available, trying gemini-1.5-flash");
      try {
        model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
      } catch (err2) {
        console.warn("gemini-1.5-flash not available, trying gemini-pro-vision");
        model = genAI.getGenerativeModel({ model: "gemini-pro-vision" });
      }
    }

    // Convert File to ArrayBuffer
    const arrayBuffer = await file.arrayBuffer();
    // Convert ArrayBuffer to Base64
    const base64String = Buffer.from(arrayBuffer).toString("base64");

    if (!base64String) {
      throw new Error("Failed to convert file to base64");
    }

    const prompt = `Analyze this receipt image and extract the following information in JSON format:
- Total amount (just the number)
- Date (in ISO format, if visible)
- Description or items purchased (brief summary)
- Merchant/store name
- Suggested category (one of: housing,transportation,groceries,utilities,entertainment,food,shopping,healthcare,education,personal,travel,insurance,gifts,bills,other-expense)

Only respond with valid JSON in this exact format, nothing else:
{
  "amount": number,
  "date": "ISO date string",
  "description": "string",
  "merchantName": "string",
  "category": "string"
}

If the image is not a receipt, return an empty object {}`;

    console.log("Sending receipt to Gemini for analysis...");

    const result = await model.generateContent([
      {
        inlineData: {
          data: base64String,
          mimeType: file.type || "image/jpeg",
        },
      },
      prompt,
    ]);

    if (!result || !result.response) {
      throw new Error("No response from Gemini API");
    }

    const response = await result.response;
    const text = response.text();

    if (!text) {
      throw new Error("Empty response from Gemini API");
    }

    console.log("Gemini response received, parsing...");

    // Clean the response - remove markdown code blocks
    const cleanedText = text.replace(/```(?:json)?\n?/g, "").trim();

    if (!cleanedText) {
      throw new Error("Cleaned response is empty");
    }

    let data;
    try {
      data = JSON.parse(cleanedText);
    } catch (parseError) {
      console.error("Error parsing JSON response:", {
        originalText: text,
        cleanedText: cleanedText,
        parseError: parseError.message,
      });
      throw new Error(`Invalid response format from Gemini: ${parseError.message}`);
    }

    // Handle empty receipt
    if (!data || Object.keys(data).length === 0) {
      throw new Error("Could not extract data from receipt. Please ensure the image is a valid receipt.");
    }

    // Validate required fields
    if (typeof data.amount !== "number" || data.amount <= 0) {
      throw new Error("Invalid amount extracted from receipt");
    }

    // If date is missing, use today's date
    const receiptDate = data.date ? new Date(data.date) : new Date();
    if (isNaN(receiptDate.getTime())) {
      throw new Error("Could not parse date from receipt, using today's date");
    }

    return {
      amount: parseFloat(data.amount),
      date: receiptDate,
      description: data.description || "Receipt",
      category: data.category || "other-expense",
      merchantName: data.merchantName || "Unknown",
    };
  } catch (error) {
    console.error("Error scanning receipt:", {
      message: error.message,
      stack: error.stack,
    });
    throw new Error(error.message || "Failed to scan receipt. Please try again with a clearer image.");
  }
}

// Helper function to calculate next recurring date
function calculateNextRecurringDate(startDate, interval) {
  const date = new Date(startDate);

  switch (interval) {
    case "DAILY":
      date.setDate(date.getDate() + 1);
      break;
    case "WEEKLY":
      date.setDate(date.getDate() + 7);
      break;
    case "MONTHLY":
      date.setMonth(date.getMonth() + 1);
      break;
    case "YEARLY":
      date.setFullYear(date.getFullYear() + 1);
      break;
  }

  return date;
}
