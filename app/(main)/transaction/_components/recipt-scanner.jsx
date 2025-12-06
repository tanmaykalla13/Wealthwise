"use client";

import { useRef, useEffect, useCallback } from "react";
import { Camera, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";
import useFetch from "@/hooks/use-fetch";
import { scanReceipt } from "@/actions/transaction";

export function ReceiptScanner({ onScanComplete }) {
  const fileInputRef = useRef(null);

  const {
    loading: scanReceiptLoading,
    fn: scanReceiptFn,
    data: scannedData,
    error: scanError,
  } = useFetch(scanReceipt);

  const handleReceiptScan = async (file) => {
    if (!file) {
      toast.error("No file selected");
      return;
    }

    // Validate file type
    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }

    // Validate file size
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      toast.error("File size should be less than 5MB");
      return;
    }

    console.log("Starting receipt scan with file:", {
      name: file.name,
      type: file.type,
      size: file.size,
    });

    try {
      await scanReceiptFn(file);
    } catch (err) {
      console.error("Receipt scan error:", err);
    }
  };

  // Use useCallback to memoize the callback
  const memoizedOnScanComplete = useCallback(onScanComplete, [onScanComplete]);

  useEffect(() => {
    if (scannedData && !scanReceiptLoading) {
      console.log("Scan completed successfully:", scannedData);
      memoizedOnScanComplete(scannedData);
      toast.success("Receipt scanned successfully");
      // Reset file input
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  }, [scanReceiptLoading, scannedData, memoizedOnScanComplete]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-4">
        <input
          type="file"
          ref={fileInputRef}
          className="hidden"
          accept="image/*"
          capture="environment"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) handleReceiptScan(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          className="w-full h-10 bg-gradient-to-br from-orange-500 via-pink-500 to-purple-500 animate-gradient hover:opacity-90 transition-opacity text-white hover:text-white"
          onClick={() => fileInputRef.current?.click()}
          disabled={scanReceiptLoading}
        >
          {scanReceiptLoading ? (
            <>
              <Loader2 className="mr-2 animate-spin" />
              <span>Scanning Receipt...</span>
            </>
          ) : (
            <>
              <Camera className="mr-2" />
              <span>Scan Receipt with AI</span>
            </>
          )}
        </Button>
      </div>

      {scanError && (
        <div className="flex gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-sm">
          <AlertCircle className="h-4 w-4 text-red-600 flex-shrink-0 mt-0.5" />
          <div className="text-red-800">
            <p className="font-semibold">Scan failed</p>
            <p className="text-xs mt-1">{scanError.message || "Please try again with a clearer image"}</p>
          </div>
        </div>
      )}
    </div>
  );
}
