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
    tokenTableBody.innerHTML = '<tr><td colspan="6">Fetching latest data...</td></tr>'; // Clear old data

    try {
        const connection = new Connection(SOLANA_RPC_URL, 'confirmed');

        // Derive Aggregator PDA
        const [aggregatorPda] = await PublicKey.findProgramAddressSync(
            [Buffer.from(AGGREGATOR_SEED)],
            PROGRAM_ID
        );
        aggregatorPdaElement.textContent = aggregatorPda.toBase58();
        console.log(`Aggregator PDA: ${aggregatorPda.toBase58()}`);

        // Fetch account info
        const accountInfo = await connection.getAccountInfo(aggregatorPda);

        if (!accountInfo) {
            throw new Error(`Aggregator account (${aggregatorPda.toBase58()}) not found. Has it been initialized?`);
        }
        if (accountInfo.owner.toBase58() !== PROGRAM_ID.toBase58()) {
            throw new Error(`Account owner (${accountInfo.owner.toBase58()}) does not match program ID.`);
        }

        console.log("Account data fetched, attempting to decode...");

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
                authority: authorityPubkey.toBase58() // Add authority for display
            });
            currentOffset += tokenInfoSize;
        }

        console.log(`Successfully decoded ${aggregatedData.length} tokens.`);

        // --- Display Data ---
        tokenTableBody.innerHTML = ''; // Clear previous data/loading message
        if (aggregatedData.length === 0) {
            tokenTableBody.innerHTML = '<tr><td colspan="5">No token data found in the aggregator account.</td></tr>'; // Update colspan
        } else {
            aggregatedData.forEach((token, index) => {
                const row = tokenTableBody.insertRow();
                row.insertCell(0).textContent = index + 1;
                row.insertCell(1).textContent = token.symbol;

                // Calculate and format dominance percentage
                try {
                    const dominanceValue = parseFloat(token.dominance); // Convert string BN to number
                    const dominancePercentage = (dominanceValue / 1e10) * 100; // 1e10 is 10^10
                    // Format to 2 decimal places and add '%'
                    row.insertCell(2).textContent = dominancePercentage.toFixed(2) + '%';
                } catch (e) {
                    console.error(`Error calculating dominance for token ${token.symbol}:`, e);
                    row.insertCell(2).textContent = 'Error'; // Display error in cell
                }

                // Insert Address as a clickable link
                const addressCell = row.insertCell(3);
                const addressLink = document.createElement('a');
                addressLink.href = `https://solscan.io/token/${token.address}`;
                addressLink.textContent = token.address;
                addressLink.target = '_blank'; // Open in new tab
                addressLink.rel = 'noopener noreferrer'; // Security best practice for target="_blank"
                addressCell.appendChild(addressLink);

                row.insertCell(4).textContent = token.priceFeedId;
                // Removed Authority cell insertion
            });
        }
        lastUpdatedElement.textContent = new Date().toLocaleString();

    } catch (error) {
        console.error("Failed to fetch or display data:", error);
        displayError(error.message || 'An unknown error occurred.');
        tokenTableBody.innerHTML = `<tr><td colspan="5">Error loading data: ${error.message}</td></tr>`; // Update colspan
    } finally {
        loadingIndicator.style.display = 'none';
        refreshButton.disabled = false;
    }
}

// Initial Setup and Event Listener
document.addEventListener('DOMContentLoaded', () => {
    // No need to check for global libraries anymore
    console.log("DOM Loaded.");
    programIdElement.textContent = PROGRAM_ID.toBase58();
    refreshButton.addEventListener('click', fetchAndDisplayData);

    // Initial data load
    fetchAndDisplayData();

    // Set up auto-refresh every 5 minutes (300,000 milliseconds)
    const refreshInterval = 5 * 60 * 1000;
    setInterval(fetchAndDisplayData, refreshInterval);
    console.log(`Auto-refresh enabled every ${refreshInterval / 1000 / 60} minutes.`);
});