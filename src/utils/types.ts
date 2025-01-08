export interface WebSocketRequest {
    jsonrpc: string;
    id: number;
    method: string;
    params: [
        {
            mentions: string[];
        },
        {
            commitment: string;
        }
    ];
}

export interface TransactionDetailsResponseArray {
    tokenTransfers?: Array<{
        fromUserAccount: string;
        toUserAccount: string;
        mint: string;
        amount: number;
    }>;
    nativeTransfers?: Array<{
        fromUserAccount: string;
        toUserAccount: string;
        amount: number;
    }>;
}

export interface DisplayDataItem {
    solMint: string;
    tokenMint: string;
    timestamp: number;
}

export interface QuoteResponse {
    inputMint: string;
    outputMint: string;
    amount: string;
    slippageBps: number;
    otherAmountThreshold?: string;
    swapMode?: string;
    fees?: {
        signatureFee: number;
        openOrdersDeposits: number[];
        ataDeposits: number[];
        totalFeeAndDeposits: number;
        minimumSOLForTransaction: number;
    };
    priceImpactPct?: number;
    routePlan?: Array<{
        swapInfo: {
            ammKey: string;
            label?: string;
            inputMint: string;
            outputMint: string;
            inAmount: number;
            outAmount: number;
            feeAmount: number;
            feeMint: string;
        };
        percent: number;
    }>;
}

export interface SerializedQuoteResponse {
    transaction: string;
    message?: string;
}

export interface RugResponse {
    success: boolean;
    data: {
        rating: number;
        warnings: string[];
    };
}

export interface PoolCreationLog {
    signature: string;
    logs: string[];
}