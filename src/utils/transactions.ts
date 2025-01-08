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
    try {
        const apiEndpoint = process.env.HELIUS_API_ENDPOINT;
        const apiKey = process.env.HELIUS_API_KEY;
        
        if (!apiEndpoint || !apiKey) {
            console.error('Missing required Helius configuration in .env file');
            return null;
        }

        const url = `${apiEndpoint}/v0/transactions/?api-key=${apiKey}`;
        
        console.log('Fetching transaction details for signature:', signature);
        
        const response = await axios.post(url, {
            transactions: [signature]
        }, {
            headers: {
                'Content-Type': 'application/json'
            }
        });

        // Log the raw response for debugging
        console.log('Raw API response:', JSON.stringify(response.data, null, 2));

        // Check if response is an empty array
        if (Array.isArray(response.data) && response.data.length === 0) {
            console.log('No transaction data found for signature:', signature);
            return null;
        }

        // Check for invalid response format
        if (!Array.isArray(response.data) || !response.data[0]) {
            console.error('Invalid response format:', response.data);
            return null;
        }

        const transactionData = response.data[0];
        
        // Extract token information
        const solMint = config.liquidity_pool.wsol_pc_mint;
        let tokenMint = '';

        // Add debug logging for accountData
        console.log('Transaction account data:', JSON.stringify(transactionData.accountData, null, 2));

        // Parse the transaction data to find the token mint
        if (transactionData.accountData) {
            for (const account of transactionData.accountData) {
                if (account.account === 'mint' && account.nativeBalance) {
                    tokenMint = account.account;
                    break;
                }
            }
        }

        if (!tokenMint) {
            console.log('Could not find token mint in transaction');
            return null;
        }

        return {
            solMint,
            tokenMint,
            timestamp: Date.now()
        };

    } catch (error) {
        if (axios.isAxiosError(error)) {
            if (error.response?.status === 401) {
                console.error('\nHelius API Authentication failed:');
                console.error('Please make sure to:');
                console.error('1. Get your API key from https://dev.helius.xyz/dashboard');
                console.error('2. Add it to your .env file as HELIUS_API_KEY=your_api_key_here');
                console.error('3. Check if your API key has sufficient credits\n');
                console.error('Current API response:', error.response?.data);
            } else {
                console.error('API Error:', error.response?.status, error.response?.data);
            }
        } else {
            console.error('Unexpected error:', error);
        }
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