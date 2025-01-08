import WebSocket from "ws";
import dotenv from "dotenv";
import { WebSocketRequest, PoolCreationLog } from "./utils/types";
import { fetchTransactionDetails, createSwapTransactions, getRugCheckConfirmed } from "./utils/transactions";
import { config } from "./utils/config";

dotenv.config();

// Validate required environment variables
function validateEnvironment(): void {
    const requiredEnvVars = [
        'HELIUS_API_KEY',
        'HELIUS_WSS_ENDPOINT',
        'HELIUS_RPC_ENDPOINT',
        'HELIUS_API_ENDPOINT',
        'JUP_HTTPS_QUOTE_URI',
        'JUP_HTTPS_SWAP_URI',
        'PRIV_KEY_WALLET'
    ];

    const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);
    
    if (missingVars.length > 0) {
        throw new Error(`Missing required environment variables: ${missingVars.join(', ')}\n` +
            'Please check your .env file and ensure all required variables are set.');
    }

    // Validate URLs
    const urlVars = ['HELIUS_WSS_ENDPOINT', 'HELIUS_RPC_ENDPOINT', 'HELIUS_API_ENDPOINT', 'JUP_HTTPS_QUOTE_URI', 'JUP_HTTPS_SWAP_URI'];
    urlVars.forEach(varName => {
        const url = process.env[varName];
        try {
            new URL(url as string);
        } catch (error) {
            throw new Error(`Invalid URL in ${varName}: ${url}`);
        }
    });
    
    // Validate API key format (basic check)
    const apiKey = process.env.HELIUS_API_KEY;
    if (!apiKey || apiKey.length < 32) {
        throw new Error('Invalid Helius API key format. Please check your HELIUS_API_KEY in .env');
    }
}

// Validate environment variables before starting
validateEnvironment();

function sendRequest(ws: WebSocket): void {
    const request: WebSocketRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [
            {
                mentions: [config.liquidity_pool.raydium_program_id],
            },
            {
                commitment: "processed",
            },
        ],
    };
    ws.send(JSON.stringify(request));
}

async function handleNewPool(signature: string): Promise<void> {
    try {
        console.log("************************************************");
        console.log("New Liquidity Pool found");
        
        // Fetch Transaction Details
        console.log("Fetching Transaction Details.....");
        const transactionDetails = await fetchTransactionDetails(signature);
        
        if (!transactionDetails) {
            console.log("Failed to fetch transaction details");
            return;
        }

        // Log all transaction details before filtering
        console.log("\n=== TRANSACTION DETAILS BEFORE FILTERING ===");
        console.log(JSON.stringify(transactionDetails, null, 2));
        console.log("===========================================\n");

        // Ensure required data is present
        if (!transactionDetails.solMint || !transactionDetails.tokenMint) {
            console.log("Missing required mint addresses");
            return;
        }

        // Log before pump.fun check
        console.log("\nChecking for pump.fun token...");
        console.log(`Token mint: ${transactionDetails.tokenMint}`);
        console.log(`Ends with 'pump': ${transactionDetails.tokenMint.toLowerCase().endsWith("pump")}`);
        console.log(`ignore_pump_fun setting: ${config.liquidity_pool.ignore_pump_fun}`);

        // Handle ignored tokens
        if (transactionDetails.tokenMint.toLowerCase().endsWith("pump") && 
            config.liquidity_pool.ignore_pump_fun) {
            console.log("Token is skipped. Ignoring Pump.fun tokens");
            console.log("************************************************");
            return;
        }

        // Log before rug check
        console.log("\nStarting rug check...");
        console.log(`Checking token: ${transactionDetails.tokenMint}`);

        // Check if the pool is a rug
        const isRugCheckPassed = await getRugCheckConfirmed(transactionDetails.tokenMint);
        if (!isRugCheckPassed) {
            console.log("Rug Check Failed! Aborted Transaction");
            console.log("************************************************");
            return;
        }

        console.log(`Token found: https://gmgn.ai/sol/token/${transactionDetails.tokenMint}`);
        
        // Create and execute swap transaction
        const txUrl = await createSwapTransactions(
            transactionDetails.solMint,
            transactionDetails.tokenMint
        );

        if (txUrl) {
            console.log(`Transaction successful! View at: ${txUrl}`);
        } else {
            console.log("Failed to execute swap transaction");
        }

    } catch (error) {
        console.error("Error handling new pool:", error);
    } finally {
        console.log("************************************************");
    }
}

async function websocketHandler(): Promise<void> {
    const wsEndpoint = process.env.HELIUS_WSS_ENDPOINT;
    const apiKey = process.env.HELIUS_API_KEY;

    if (!wsEndpoint || !apiKey) {
        throw new Error("Missing required Helius configuration in .env file");
    }

    try {
        // Construct WebSocket URL with API key
        const wsUrl = `${wsEndpoint}/?api-key=${apiKey}`;
        
        console.log('Connecting to WebSocket...');
        
        const ws = new WebSocket(wsUrl, {
            headers: {
                'Origin': 'https://mainnet.helius-rpc.com'
            }
        });

        ws.on("open", () => {
            sendRequest(ws);
            console.log("WebSocket connection established and listening");
        });

        ws.on("message", async (data: WebSocket.Data) => {
            try {
                const jsonString = data.toString();
                const parsedData = JSON.parse(jsonString);

                const logs = parsedData?.params?.result?.value?.logs;
                const signature = parsedData?.params?.result?.value?.signature;

                if (!Array.isArray(logs) || typeof signature !== "string") {
                    return;
                }

                const containsCreate = logs.some(
                    (log: string) => 
                    typeof log === "string" && 
                    log.includes("Program log: initialize2: InitializeInstruction2")
                );

                if (!containsCreate) {
                    return;
                }

                // Close current connection to handle the transaction
                ws.close(1000, "Handling transaction");
                
                // Process the new pool
                await handleNewPool(signature);

                // Restart websocket handler
                await websocketHandler();
                
            } catch (error) {
                console.error("Error processing WebSocket message:", error);
                
                // Attempt to reconnect on error
                ws.close();
                setTimeout(websocketHandler, 5000);
            }
        });

        ws.on("error", (error) => {
            console.error("WebSocket error:", error);
            if ((error as any).code === 'ECONNREFUSED') {
                console.error('Could not connect to WebSocket server. Please check your Helius configuration.');
            }
        });

        ws.on("close", (code, reason) => {
            console.log(`WebSocket closed with code ${code} and reason: ${reason}`);
            
            // Attempt to reconnect if not intentionally closed
            if (code !== 1000) {
                console.log('Attempting to reconnect in 5 seconds...');
                setTimeout(websocketHandler, 5000);
            }
        });

    } catch (error) {
        console.error("Error in websocket connection:", error);
        setTimeout(websocketHandler, 5000);
    }
}

// Start the WebSocket handler
websocketHandler().catch((error) => {
    console.error("Fatal error in websocket handler:", error);
    process.exit(1);
});