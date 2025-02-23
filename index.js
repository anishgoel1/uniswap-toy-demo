require('dotenv').config();
const { ethers } = require('ethers');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const CONFIG = {
    POOL_ADDRESS: '0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8',
    BLOCKS_PER_HOUR: 300, 
    HOURS_TO_FETCH: 6,    
    FETCH_INTERVAL: 5 * 60 * 1000, // 5 minutes in milliseconds
    DECIMALS: {
        USDC: 6,
        ETH: 18
    },
    PORT: 3000,
    MAX_RETRIES: 3,
    RETRY_DELAY: 5000 // 5 seconds
};

const SWAP_EVENT = 'event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)';

class SwapMonitor {
    constructor(provider, wss) {
        this.provider = provider;
        this.wss = wss;
        this.poolContract = new ethers.Contract(CONFIG.POOL_ADDRESS, [SWAP_EVENT], provider);
        this.lastFetchedBlock = null;
        this.displayedSwaps = new Set();
        this.stats = this.resetStats();
        this.lastProcessedEvents = [];

        // Handle new WebSocket connections
        this.wss.on('connection', async (ws) => {
            console.log('New client connected');
            // Fetch latest data on new connection
            await this.fetchLatestSwaps();
        });
    }

    resetStats() {
        return {
            totalSwaps: 0,
            ethToUsdc: 0,
            usdcToEth: 0,
            lastUpdate: Date.now()
        };
    }

    formatAmount(amount, decimals) {
        const value = Math.abs(Number(ethers.formatUnits(amount, decimals)));
        const options = { minimumFractionDigits: decimals === CONFIG.DECIMALS.USDC ? 2 : 6, maximumFractionDigits: decimals === CONFIG.DECIMALS.USDC ? 2 : 6 };
        return value.toLocaleString(undefined, options);
    }

    formatSwapForUI(event, timestamp) {
        const { amount0, amount1 } = event.args;
        const swapTime = timestamp * 1000;
        const hoursDiff = (Date.now() - swapTime) / (1000 * 60 * 60);
        
        // Skip old events
        if (hoursDiff > CONFIG.HOURS_TO_FETCH) return null;

        const isUsdcToEth = BigInt(amount0) > 0n;
        const ethAmount = Math.abs(Number(ethers.formatUnits(amount1, CONFIG.DECIMALS.ETH)));
        const usdcAmount = Math.abs(Number(ethers.formatUnits(amount0, CONFIG.DECIMALS.USDC)));
        const price = usdcAmount / ethAmount;

        return {
            time: swapTime,
            type: isUsdcToEth ? 'USDC → ETH' : 'ETH → USDC',
            amount: isUsdcToEth
                ? `${this.formatAmount(amount0, CONFIG.DECIMALS.USDC)} USDC → ${this.formatAmount(amount1, CONFIG.DECIMALS.ETH)} ETH`
                : `${this.formatAmount(amount1, CONFIG.DECIMALS.ETH)} ETH → ${this.formatAmount(amount0, CONFIG.DECIMALS.USDC)} USDC`,
            price: `$${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/ETH`,
            block: event.blockNumber,
            tx: event.transactionHash,
            isUsdcToEth: isUsdcToEth,
            nextUpdate: Date.now() + CONFIG.FETCH_INTERVAL,
            amount0: amount0.toString(),
            amount1: amount1.toString()
        };
    }

    async fetchLatestSwaps() {
        try {
            const currentBlock = await this.provider.getBlockNumber();
            const fromBlock = currentBlock - (CONFIG.BLOCKS_PER_HOUR * CONFIG.HOURS_TO_FETCH);
            
            if (fromBlock >= currentBlock) return;

            const events = await this.poolContract.queryFilter('Swap', fromBlock, currentBlock);
            if (!events.length) return;

            // Get unique blocks and their timestamps
            const uniqueBlocks = [...new Set(events.map(e => e.blockNumber))];
            const blocks = await Promise.all(
                uniqueBlocks.map(n => this.provider.getBlock(n))
            );
            const timestamps = Object.fromEntries(
                blocks.filter(Boolean).map(b => [b.number, b.timestamp])
            );

            // First collect all valid events with their timestamps
            const validEvents = events
                .map(event => {
                    const timestamp = timestamps[event.blockNumber];
                    if (!timestamp) return null;
                    const swap = this.formatSwapForUI(event, timestamp);
                    if (!swap) return null;
                    return {
                        ...swap,
                        blockTimestamp: timestamp
                    };
                })
                .filter(Boolean);

            // Sort by timestamp descending (newest first), then by block number descending for same timestamp
            validEvents.sort((a, b) => {
                const timeA = new Date(a.time).getTime();
                const timeB = new Date(b.time).getTime();
                if (timeA !== timeB) {
                    return timeB - timeA; // Primary sort by timestamp
                }
                return b.block - a.block; // Secondary sort by block number
            });

            // Send to all connected clients
            const clients = [...this.wss.clients].filter(client => client.readyState === WebSocket.OPEN);
            
            if (clients.length > 0) {
                clients.forEach(client => {
                    // Send refresh signal
                    client.send(JSON.stringify({ 
                        type: 'refresh', 
                        nextUpdate: Date.now() + CONFIG.FETCH_INTERVAL,
                        maintainState: false
                    }));
                    // Send events in sorted order
                    validEvents.forEach(swap => {
                        client.send(JSON.stringify(swap));
                    });
                });
            }

            this.lastFetchedBlock = currentBlock;
            console.log(`Processed ${validEvents.length} swaps from block ${fromBlock} to ${currentBlock}`);
            console.log(`Next update in ${CONFIG.FETCH_INTERVAL / 1000} seconds`);
        } catch (error) {
            console.error('Error fetching swaps:', error);
        }
    }

    async start() {
        try {
            console.log('Connecting to Uniswap V3 ETH-USDC pool...');
            await this.fetchLatestSwaps();
            console.log('Historical data loaded, monitoring for new swaps...');
            
            // Set up interval for updates
            setInterval(() => this.fetchLatestSwaps(), CONFIG.FETCH_INTERVAL);
        } catch (error) {
            console.error('Error starting monitor:', error);
            await this.reconnectProvider();
        }
    }

    async reconnectProvider() {
        for (let i = 0; i < CONFIG.MAX_RETRIES; i++) {
            try {
                this.provider = new ethers.JsonRpcProvider(process.env.ETHEREUM_NODE_URL);
                this.poolContract = new ethers.Contract(CONFIG.POOL_ADDRESS, [SWAP_EVENT], this.provider);
                return;
            } catch (error) {
                console.error(`Reconnection attempt ${i + 1} failed:`, error);
                if (i < CONFIG.MAX_RETRIES - 1) {
                    await new Promise(resolve => setTimeout(resolve, CONFIG.RETRY_DELAY));
                }
            }
        }
        process.exit(1);
    }
}

// Setup Express server
const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Serve static files
app.use(express.static(path.join(__dirname)));

// Start server and monitoring
server.listen(CONFIG.PORT, () => {
    console.log(`Server running at http://localhost:${CONFIG.PORT}`);
    
    // Start swap monitoring
    new SwapMonitor(
        new ethers.JsonRpcProvider(process.env.ETHEREUM_NODE_URL),
        wss
    ).start();
}); 