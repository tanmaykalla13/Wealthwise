"use server";

import { db } from "@/lib/prisma";
import { auth } from "@clerk/nextjs/server";
import { revalidatePath } from "next/cache";

const serializeDecimal = (obj) => {
  const serialized = { ...obj };
  if (obj.balance) {
    serialized.balance = obj.balance.toNumber();
  }
  if (obj.amount) {
    serialized.amount = obj.amount.toNumber();
  }
  return serialized;
};

export async function getAccountWithTransactions(accountId) {
  const { userId } = await auth();
  if (!userId) throw new Error("Unauthorized");

  // clerkUserId is a unique field on the User model, but Prisma's findUnique
  // requires the exact unique field name. Using findFirst with where ensures
  // correct lookup across environments and avoids using composite where shapes.
  const user = await db.user.findFirst({
    where: { clerkUserId: userId },
  });

  if (!user) throw new Error("User not found");

  // Use findFirst to locate an account that matches both id and userId.
  const account = await db.account.findFirst({
    where: {
      id: accountId,
      userId: user.id,
    },
    include: {
      transactions: {
        orderBy: { date: "desc" },
      },
      _count: {
        select: { transactions: true },
      },
    },
  });

  if (!account) return null;

  return {
    ...serializeDecimal(account),
    transactions: account.transactions.map(serializeDecimal),
  };
}

export async function bulkDeleteTransactions(transactionIds) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findFirst({
      where: { clerkUserId: userId },
    });

    if (!user) throw new Error("User not found");

    // Get transactions to calculate balance changes
    const transactions = await db.transaction.findMany({
      where: {
        id: { in: transactionIds },
        userId: user.id,
      },
    });

    // Group transactions by account to update balances
    // Prisma returns Decimal objects for numeric fields. Keep them as-is for
    // Prisma increment operations. We'll accumulate Decimal-like values using
    // JavaScript numbers when possible, but prefer the raw Decimal from Prisma
    // by using toNumber() only for local arithmetic. If Decimal isn't available
    // (e.g., in mocks), fall back to Number().
    const accountBalanceChanges = transactions.reduce((acc, transaction) => {
      const amt = transaction.amount && typeof transaction.amount.toNumber === 'function'
        ? transaction.amount.toNumber()
        : Number(transaction.amount || 0);

      const change = transaction.type === "EXPENSE" ? amt : -amt;
      acc[transaction.accountId] = (acc[transaction.accountId] || 0) + change;
      return acc;
    }, {});

    // Delete transactions and update account balances in a transaction
    await db.$transaction(async (tx) => {
      // Delete transactions
      await tx.transaction.deleteMany({
        where: {
          id: { in: transactionIds },
          userId: user.id,
        },
      });

      // Update account balances
      for (const [accountId, balanceChange] of Object.entries(
        accountBalanceChanges
      )) {
        await tx.account.update({
          where: { id: accountId },
          data: {
            balance: {
              increment: balanceChange,
            },
          },
        });
      }
    });

    revalidatePath("/dashboard");
    revalidatePath("/account/[id]");

    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

export async function updateDefaultAccount(accountId) {
  try {
    const { userId } = await auth();
    if (!userId) throw new Error("Unauthorized");

    const user = await db.user.findFirst({
      where: { clerkUserId: userId },
    });

    if (!user) {
      throw new Error("User not found");
    }

    // First, unset any existing default account for the user
    await db.account.updateMany({
      where: {
        userId: user.id,
        isDefault: true,
      },
      data: { isDefault: false },
    });

    // Then set the new default account (ensure the account belongs to the user)
    const account = await db.account.updateMany({
      where: {
        id: accountId,
        userId: user.id,
      },
      data: { isDefault: true },
    });

    revalidatePath("/dashboard");
    // updateMany returns a BatchPayload; refetch the account to return its data
    const updated = await db.account.findUnique({ where: { id: accountId } });
    return { success: true, data: updated ? serializeDecimal(updated) : null };
  } catch (error) {
    return { success: false, error: error.message };
  }
}
