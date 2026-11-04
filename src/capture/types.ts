export type CaptureItem = {
  name: string; quantity: number; price: number; discount: number; amount: number;
  ikpu?: string; categoryId: string | null;
};
export type CaptureReceipt = {
  kind: 'soliq' | 'photo'; receiptKey: string;
  merchant: { tin: string | null; name: string | null; address: string | null };
  date: string; total: number; cardTotal?: number; cashTotal?: number;
  /** Soliq refund receipt (isRefund / refundPaymentId): the draft is income and the app should say so. */
  isRefund?: true; items: CaptureItem[];
};
export type CaptureDraft = {
  draftId: string; type: 'expense' | 'income'; amount: number; currency: string;
  categoryId: string | null; categoryConfidence: 'high' | 'medium' | 'low';
  accountId: string | null; date: string; comment: string;
  lowConfidenceFields: Array<'amount' | 'category' | 'account' | 'date'>;
  items?: CaptureItem[];
};
export type CaptureMetadata = {
  kind: 'voice' | 'receipt_soliq' | 'receipt_photo'; receiptKey?: string;
  merchantTin?: string; suggestedCategoryId?: string; draftId?: string;
};
