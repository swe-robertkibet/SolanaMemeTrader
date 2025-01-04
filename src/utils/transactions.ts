import axios from 'axios';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { Wallet } from "@project-serum/anchor";
import bs58 from 'bs58';
import dotenv from 'dotenv';
import { config } from './config';
import { TransactionDetailsResponseArray, DisplayDataItem, QuoteResponse, SerializedQuoteResponse, RugResponse } from './types';

dotenv.config();

const RETRY_TIMEOUT = config.tx.get_retry_timeout;
const RETRY_INTERVAL = config.tx.get_retry_interval;

export async function fetchTransactionDetails(signature: string): Promise<DisplayDataItem | null> {
    const heliusUri = process.env.HELIUS_HTTPS_URI_TX || "";
    
    try {
        const response = await axios.get<TransactionDetailsResponseArray[]>(`${heliusUri}${signature}`);
        if (!response.data || !Array.isArray(response.data) || response.data.length === 0) {
            console.error('Invalid transaction details response');
            return null;
        }

        const transactionData = response.data[0];
        return {
            solMint: transactionData.solMint,
            tokenMint: transactionData.tokenMint,
            timestamp: Date.now()
        };
    } catch (error) {
        console.error('Error fetching transaction details:', error);
        return null;
    }
}

export async function createSwapTransactions(solMint: string, tokenMint: string): Promise<string | null> {
    const quoteUrl = process.env.JUP_HTTPS_QUOTE_URI || "";
    const swapUrl = process.env.JUP_HTTPS_SWAP_URI || "";
    const rpcUrl = process.env.HELIUS_HTTPS_URI || "";
    const privateKey = process.env.PRIV_KEY_WALLET || "";
    
    if (!privateKey) {
        console.error('Private key not found in environment variables');
        return null;
    }
    
    const myWallet = new Wallet(Keypair.fromSecretKey(bs58.decode(privateKey)));

    try {
        // Request a quote for swapping SOL for new tokens
        const quoteResponse = await axios.get<QuoteResponse>(quoteUrl, {
            params: {
                inputMint: solMint,
                outputMint: tokenMint,
                amount: config.swap.amount,
                slippageBps: config.swap.slippageBps,
            },
            timeout: 5000,
        });

        if (!quoteResponse.data) {
            console.error('No quote data received');
            return null;
        }

        // Serialize the quote into a swap transaction
        const swapTransaction = await axios.post<SerializedQuoteResponse>(
            swapUrl,
            {
                quoteResponse: quoteResponse.data,
                userPublicKey: myWallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicSlippage: {
                    maxBps: 300,
                },
                prioritizationFeeLamports: {
                    priorityLevelWithMaxLamports: {
                        maxLamports: 1000000,
                        priorityLevel: "veryHigh",
                    },
                },
            },
            {
                headers: {
                    "Content-Type": "application/json",
                },
                timeout: 5000,
            }
        );

        if (!swapTransaction.data || !swapTransaction.data.transaction) {
            console.error('Invalid swap transaction response');
            return null;
        }

        // Set up connection and deserialize transaction
        const connection = new Connection(rpcUrl);
        const swapTransactionBuf = Buffer.from(swapTransaction.data.transaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTransactionBuf);

        // Sign transaction
        transaction.sign([myWallet.payer]);

        // Get latest blockhash and execute transaction
        const latestBlockhash = await connection.getLatestBlockhash();
        const rawTransaction = transaction.serialize();
        
        const txid = await connection.sendRawTransaction(rawTransaction, {
            skipPreflight: true,
            maxRetries: 3
        });

        // Confirm transaction
        const confirmation = await connection.confirmTransaction({
            blockhash: latestBlockhash.blockhash,
            lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
            signature: txid,
        });

        if (confirmation.value.err) {
            throw new Error(`Transaction failed: ${confirmation.value.err}`);
        }

        return `https://solscan.io/tx/${txid}`;
    } catch (error) {
        console.error('Error in swap transaction:', error);
        return null;
    }
}

export async function getRugCheckConfirmed(tokenMint: string): Promise<boolean> {
    try {
        const response = await axios.get<RugResponse>(
            `https://api.rugcheck.xyz/v1/tokens/${tokenMint}/report/summary`
        );

        if (!response.data || !response.data.success) {
            console.error('Invalid rug check response');
            return false;
        }

        const { rating, warnings } = response.data.data;

        // Check for disallowed warnings
        const hasDisallowedWarning = warnings.some(warning => 
            config.rug_check.not_allowed.includes(warning)
        );

        if (hasDisallowedWarning) {
            console.log('Token failed rug check due to disallowed warning');
            return false;
        }

        // Check ownership percentage
        if (rating > config.rug_check.single_holder_ownership) {
            console.log('Token failed rug check due to high single holder ownership');
            return false;
        }

        return true;
    } catch (error) {
        console.error('Error performing rug check:', error);
        return false;
    }
}