import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer'; // Import Buffer polyfill

// Polyfill global for libraries that might expect it (like anchor)
window.Buffer = Buffer;

// Configuration
const SOLANA_RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID_STR = "EtMdPZQdHqCsbpwy6CWRmjG6kKaEu1rSW7KjRTfnGi23"; // Your program ID as string
const AGGREGATOR_SEED = "aggregator_v2"; // The seed used for the aggregator PDA

let PROGRAM_ID = new PublicKey(PROGRAM_ID_STR);

// DOM Elements
const programIdElement = document.getElementById('program-id');
const aggregatorPdaElement = document.getElementById('aggregator-pda');
const refreshButton = document.getElementById('refresh-button');
const loadingIndicator = document.getElementById('loading-indicator');
const errorMessageElement = document.getElementById('error-message');
const tokenTableBody = document.getElementById('token-table-body');
const lastUpdatedElement = document.getElementById('last-updated');

// Helper to display errors
function displayError(message) {
    errorMessageElement.textContent = `Error: ${message}`;
    errorMessageElement.style.display = 'block';
    console.error(message);
}

// Helper to hide errors
function clearError() {
    errorMessageElement.textContent = '';
    errorMessageElement.style.display = 'none';
}

// Helper function to create Solscan links
function createSolscanLink(element, address, cluster = 'devnet') {
    element.innerHTML = ''; // Clear existing content (like "Loading...")
    const link = document.createElement('a');
    link.href = `https://solscan.io/account/${address}?cluster=${cluster}`;
    link.textContent = address;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    element.appendChild(link);
}

// Helper to format bytes to string (uses imported Buffer)
function bytesToString(bytes) {
    const buffer = Buffer.from(bytes);
    const firstNull = buffer.indexOf(0);
    const relevantBytes = firstNull === -1 ? buffer : buffer.subarray(0, firstNull);
    return new TextDecoder("utf-8").decode(relevantBytes);
}

// Fetch and display data function
async function fetchAndDisplayData() {
    console.log("Attempting to fetch data...");
    clearError();
    loadingIndicator.style.display = 'inline';
    refreshButton.disabled = true;
    // Don't clear table body here, wait until data is confirmed or error occurs

    try {
        const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

        // Create Program ID link once (if not already done)
        if (!programIdElement.hasChildNodes() || programIdElement.textContent === 'Loading...') {
            createSolscanLink(programIdElement, PROGRAM_ID.toBase58(), 'devnet');
        }

        // Derive Aggregator PDA
        const [aggregatorPda] = await PublicKey.findProgramAddressSync(
            [Buffer.from(AGGREGATOR_SEED)],
            PROGRAM_ID
        );

        // Create Aggregator PDA link
        createSolscanLink(aggregatorPdaElement, aggregatorPda.toBase58(), 'devnet');
        console.log(`Aggregator PDA: ${aggregatorPda.toBase58()}`);


        // Fetch account info
        const accountInfo = await connection.getAccountInfo(aggregatorPda);

        if (!accountInfo) {
            tokenTableBody.innerHTML = '<tr><td colspan="5">Aggregator account not found.</td></tr>'; // Clear loading message only on error/no data
            throw new Error(`Aggregator account (${aggregatorPda.toBase58()}) not found. Has it been initialized?`);
        }
        if (accountInfo.owner.toBase58() !== PROGRAM_ID.toBase58()) {
            tokenTableBody.innerHTML = '<tr><td colspan="5">Account owner mismatch.</td></tr>';
            throw new Error(`Account owner (${accountInfo.owner.toBase58()}) does not match program ID.`);
        }

        console.log("Account data fetched, attempting to decode...");
        tokenTableBody.innerHTML = '<tr><td colspan="5">Decoding data...</td></tr>'; // Update status

        // --- Manual Decoding ---
        // Account discriminator (8 bytes)
        const discriminator = accountInfo.data.subarray(0, 8);
        console.log(`Discriminator (hex): ${discriminator.toString('hex')}`);

        // Authority (32 bytes)
        const authorityOffset = 8;
        const authorityPubkey = new PublicKey(accountInfo.data.subarray(authorityOffset, authorityOffset + 32));

        // total_tokens (u32, 4 bytes, little-endian)
        const totalTokensOffset = authorityOffset + 32;
        const totalTokens = accountInfo.data.readUInt32LE(totalTokensOffset);

        // Vec<TokenInfo> length (u32, 4 bytes, little-endian)
        // NOTE: Your Rust struct AggregatedOracleData uses Vec<TokenInfo>, not Vec<AggregatedTokenInfo>
        const vecLenOffset = totalTokensOffset + 4;
        const vecLen = accountInfo.data.readUInt32LE(vecLenOffset);

        console.log(`Decoded Header: Authority=${authorityPubkey.toBase58()}, TotalTokens=${totalTokens}, VecLen=${vecLen}`);

        if (vecLen !== totalTokens) {
            console.warn(`Warning: Decoded vector length (${vecLen}) does not match totalTokens field (${totalTokens}). Using vecLen.`);
        }

        // Data Vec<TokenInfo>
        const dataOffset = vecLenOffset + 4;
        let currentOffset = dataOffset;
        const aggregatedData = [];

        // Size of TokenInfo (not AggregatedTokenInfo)
        const tokenInfoSize = 10 + 8 + 64 + 64; // symbol(10) + dominance(8) + address(64) + price_feed_id(64)

        for (let i = 0; i < vecLen; i++) {
            if (currentOffset + tokenInfoSize > accountInfo.data.length) {
                throw new Error(`Buffer overflow detected while reading token ${i + 1}. Expected size ${tokenInfoSize}, remaining buffer ${accountInfo.data.length - currentOffset}`);
            }
            const tokenData = accountInfo.data.subarray(currentOffset, currentOffset + tokenInfoSize);

            const symbolBytes = tokenData.subarray(0, 10);
            const dominanceBn = new anchor.BN(tokenData.subarray(10, 18), 'le'); // Read u64 as little-endian BN
            const addressBytes = tokenData.subarray(18, 18 + 64);
            const priceFeedIdBytes = tokenData.subarray(18 + 64, 18 + 64 + 64);
            // Removed timestamp decoding as it's not in TokenInfo

            aggregatedData.push({
                symbol: bytesToString(symbolBytes),
                dominance: dominanceBn.toString(),
                address: bytesToString(addressBytes),
                priceFeedId: bytesToString(priceFeedIdBytes),
                // lastUpdatedTimestamp: timestampBn.toString(), // Removed
                authority: authorityPubkey.toBase58() // Keep authority internally if needed later, just not displayed
            });
            currentOffset += tokenInfoSize;
        }

        console.log(`Successfully decoded ${aggregatedData.length} tokens.`);

        // --- Display Data ---
        tokenTableBody.innerHTML = ''; // Clear previous data/loading message
        if (aggregatedData.length === 0) {
            tokenTableBody.innerHTML = '<tr><td colspan="5">No token data found in the aggregator account.</td></tr>';
        } else {
            aggregatedData.forEach((token, index) => {
                const row = tokenTableBody.insertRow();
                row.insertCell(0).textContent = index + 1;
                row.insertCell(1).textContent = token.symbol;

                // Calculate and format dominance percentage
                try {
                    const dominanceValue = parseFloat(token.dominance); // Convert string BN to number
                    const dominancePercentage = (dominanceValue / 1e10) * 100; // 1e10 is 10^10
                    row.insertCell(2).textContent = dominancePercentage.toFixed(2) + '%';
                } catch (e) {
                    console.error(`Error calculating dominance for token ${token.symbol}:`, e);
                    row.insertCell(2).textContent = 'Error'; // Display error in cell
                }

                // Insert Address as a clickable link (points to token page on mainnet)
                const addressCell = row.insertCell(3);
                const addressLink = document.createElement('a');
                // Corrected Link: Use /token/ path and cluster=mainnet
                addressLink.href = `https://solscan.io/token/${token.address}?cluster=mainnet`;
                addressLink.textContent = token.address;
                addressLink.target = '_blank'; // Open in new tab
                addressLink.rel = 'noopener noreferrer'; // Security best practice for target="_blank"
                addressCell.appendChild(addressLink);

                // Insert Price Feed ID as plain text (no link)
                const priceFeedCell = row.insertCell(4);
                priceFeedCell.textContent = token.priceFeedId; // Just display the ID

                // Removed Authority cell insertion
            });
        }
        lastUpdatedElement.textContent = new Date().toLocaleString();

    } catch (error) {
        console.error("Failed to fetch or display data:", error);
        displayError(error.message || 'An unknown error occurred.');
        // Ensure table body shows error if it hasn't been set yet
        if (tokenTableBody.innerHTML.includes('Decoding data...') || tokenTableBody.innerHTML === '') {
            tokenTableBody.innerHTML = `<tr><td colspan="5">Error loading data: ${error.message}</td></tr>`; // Update colspan
        }
    } finally {
        loadingIndicator.style.display = 'none';
        refreshButton.disabled = false;
    }
}

// Initial Setup and Event Listener
document.addEventListener('DOMContentLoaded', () => {
    console.log("DOM Loaded.");
    // Removed programIdElement.textContent = PROGRAM_ID.toBase58();
    refreshButton.addEventListener('click', fetchAndDisplayData);

    // Initial data load
    fetchAndDisplayData();

    // Set up auto-refresh every 5 minutes (300,000 milliseconds)
    const refreshInterval = 5 * 60 * 1000;
    setInterval(fetchAndDisplayData, refreshInterval);
    console.log(`Auto-refresh enabled every ${refreshInterval / 1000 / 60} minutes.`);
});