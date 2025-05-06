import * as anchor from '@coral-xyz/anchor';
import { Connection, PublicKey } from '@solana/web3.js';
import { Buffer } from 'buffer'; // Import Buffer polyfill

// Polyfill global for libraries that might expect it (like anchor)
window.Buffer = Buffer;

// Configuration
//const SOLANA_RPC_URL = "https://api.devnet.solana.com";
const SOLANA_RPC_URL = "http://127.0.0.1:8900";


const PROGRAM_ID_STR = "DP9kZHS77pbTuTHKNsaxqFjrUboFLGXvyCQsxYvWM26c"; // Your program ID as string
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
            tokenTableBody.innerHTML = '<tr><td colspan="6">Aggregator account not found.</td></tr>'; // Adjusted colspan
            throw new Error(`Aggregator account (${aggregatorPda.toBase58()}) not found. Has it been initialized?`);
        }
        if (accountInfo.owner.toBase58() !== PROGRAM_ID.toBase58()) {
            tokenTableBody.innerHTML = '<tr><td colspan="6">Account owner mismatch.</td></tr>'; // Adjusted colspan
            throw new Error(`Account owner (${accountInfo.owner.toBase58()}) does not match program ID.`);
        }

        console.log("Account data fetched, attempting to decode...");
        tokenTableBody.innerHTML = '<tr><td colspan="6">Decoding data...</td></tr>'; // Adjusted colspan

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
        const vecLenOffset = totalTokensOffset + 4;
        const vecLen = accountInfo.data.readUInt32LE(vecLenOffset);

        console.log(`Decoded Header: Authority=${authorityPubkey.toBase58()}, TotalTokens=${totalTokens}, VecLen=${vecLen}`);

        if (vecLen !== totalTokens) {
            // This warning is fine, vecLen (from the Vec itself) is usually more reliable if totalTokens is just a counter.
            console.warn(`Warning: Decoded vector length (${vecLen}) from Vec prefix does not match totalTokens field (${totalTokens}). Using vecLen for iteration if smaller, or totalTokens if vecLen is unexpectedly large (like max_capacity). For display, totalTokens is probably the intended 'active' count.`);
        }
        
        // Use totalTokens for iterating as it reflects the active elements after cleanup
        const itemsToDecode = totalTokens; 

        // Data Vec<TokenInfo>
        const dataOffset = vecLenOffset + 4;
        let currentOffset = dataOffset;
        const aggregatedData = [];
        let totalDominanceBN = new anchor.BN(0);

        // --- Size of TokenInfo ---
        // symbol(10) + dominance(u64, 8) + address(string padded, 64) + price_feed_id(string padded, 64) + timestamp(i64, 8)
        const tokenInfoSize = 10 + 8 + 64 + 64 + 8; // Updated to 154 bytes

        for (let i = 0; i < itemsToDecode; i++) { // Iterate based on totalTokens
            if (currentOffset + tokenInfoSize > accountInfo.data.length) {
                throw new Error(`Buffer overflow detected while reading token ${i + 1}. Expected size ${tokenInfoSize}, remaining buffer ${accountInfo.data.length - currentOffset}`);
            }
            const tokenData = accountInfo.data.subarray(currentOffset, currentOffset + tokenInfoSize);

            // symbol: First 10 bytes
            const symbolBytes = tokenData.subarray(0, 10);
            // dominance: Next 8 bytes (offset 10)
            const dominanceBn = new anchor.BN(tokenData.subarray(10, 10 + 8), 'le');
            // address: Next 64 bytes (offset 18)
            const addressBytes64 = tokenData.subarray(18, 18 + 64);
            // price_feed_id: Next 64 bytes (offset 18 + 64 = 82)
            const priceFeedIdBytes64 = tokenData.subarray(82, 82 + 64);
            // timestamp: Next 8 bytes (offset 82 + 64 = 146)
            const timestampBn = new anchor.BN(tokenData.subarray(146, 146 + 8), 'le');


            const addressString = bytesToString(addressBytes64);
            const priceFeedIdString = bytesToString(priceFeedIdBytes64);

            totalDominanceBN = totalDominanceBN.add(dominanceBn);

            aggregatedData.push({
                symbol: bytesToString(symbolBytes),
                dominance: dominanceBn.toString(),
                address: addressString,
                priceFeedId: priceFeedIdString,
                timestamp: timestampBn, // Store as BN, format later for display
                authority: authorityPubkey.toBase58()
            });
            currentOffset += tokenInfoSize;
        }

        console.log(`Successfully decoded ${aggregatedData.length} tokens.`);

        // --- Display Data ---
        tokenTableBody.innerHTML = ''; 
        if (aggregatedData.length === 0) {
            tokenTableBody.innerHTML = '<tr><td colspan="6">No token data found in the aggregator account.</td></tr>'; // Adjusted colspan
        } else {
            aggregatedData.forEach((token, index) => {
                const row = tokenTableBody.insertRow();
                row.insertCell(0).textContent = index + 1;
                row.insertCell(1).textContent = token.symbol;

                try {
                    const dominanceValue = parseFloat(token.dominance); 
                    const dominancePercentage = (dominanceValue / 1e10) * 100; 
                    row.insertCell(2).textContent = dominancePercentage.toFixed(3) + '%'; 
                } catch (e) {
                    console.error(`Error calculating dominance for token ${token.symbol}:`, e);
                    row.insertCell(2).textContent = 'Error'; 
                }

                const addressCell = row.insertCell(3);
                const addressLink = document.createElement('a');
                addressLink.href = `https://solscan.io/token/${token.address}?cluster=mainnet`; 
                addressLink.textContent = token.address; 
                addressLink.target = '_blank';
                addressLink.rel = 'noopener noreferrer';
                addressCell.appendChild(addressLink);

                const priceFeedCell = row.insertCell(4);
                priceFeedCell.textContent = token.priceFeedId;

                // Insert Timestamp (formatted)
                const timestampCell = row.insertCell(5);
                try {
                    // Convert BN timestamp to number (seconds), then to milliseconds for Date object
                    const timestampSeconds = token.timestamp.toNumber();
                    const date = new Date(timestampSeconds * 1000);
                    const dateString = date.toLocaleDateString();
                    const timeString = date.toLocaleTimeString();
                    timestampCell.innerHTML = `${dateString}<br>${timeString}`;
                } catch (e) {
                    console.error(`Error formatting timestamp for token ${token.symbol}:`, e);
                    timestampCell.textContent = 'Error';
                }

            });
        }

        // --- Display Total Dominance ---
        const totalDominanceCell = document.getElementById('total-dominance-cell');
        if (totalDominanceCell) {
            try {
                // Convert the total BN to a number for calculation.
                const totalDominanceValue = parseFloat(totalDominanceBN.toString());
                if (isNaN(totalDominanceValue)) {
                    throw new Error("Total dominance calculation resulted in NaN");
                }
                const totalDominancePercentage = (totalDominanceValue / 1e10) * 100;
                totalDominanceCell.textContent = totalDominancePercentage.toFixed(3) + '%';
            } catch (e) {
                console.error("Error calculating or displaying total dominance:", e);
                totalDominanceCell.textContent = 'Error';
            }
        } else {
            console.warn("Total dominance cell not found.");
        }

        lastUpdatedElement.textContent = new Date().toLocaleString();

    } catch (error) { // Changed 'e' to 'error' to match the user's original code block for this section
        console.error("Failed to fetch or display data:", error); // Changed 'e' to 'error'
        displayError(error.message || 'An unknown error occurred.'); // Changed 'e' to 'error'
        // Ensure table body shows error if it hasn't been set yet
        // Note: the original code had a logic error here, it was trying to use 'error' inside the 'if' condition from the 'catch (e)' block.
        // I'm keeping the 'error.message' as it is in the provided new code.
        if (tokenTableBody.innerHTML.includes('Decoding data...') || tokenTableBody.innerHTML === '') {
             tokenTableBody.innerHTML = `<tr><td colspan="6">Error loading data: ${error.message}</td></tr>`; // Adjusted colspan
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