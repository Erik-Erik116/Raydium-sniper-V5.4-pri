import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, TransactionInstruction, TransactionMessage, VersionedTransaction, sendAndConfirmTransaction } from "@solana/web3.js"
import { TOKEN_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createBurnCheckedInstruction, createCloseAccountInstruction, createTransferCheckedInstruction, getAssociatedTokenAddress } from "@solana/spl-token";
import { SPL_ACCOUNT_LAYOUT, TokenAccount } from "@raydium-io/raydium-sdk";
import base58 from "bs58"
import dotenv from 'dotenv';
import { sleep } from "./srcutils/commonFunc";
import { logger } from "./logger";
import { sendBundle } from "./srcutils/liljito";

dotenv.config()

const RPC_ENDPOINT = process.env.RPC_ENDPOINT;
const RPC_WEBSOCKET_ENDPOINT = process.env.WEBSOCKET_RPC_ENDPOINT;
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const GATHER_SLIPPAGE = Number(process.env.GATHER_SLIPPAGE);
const GATHER_FEE_LEVEL = Number(process.env.GATHER_FEE_LEVEL);
const BURN_QUANTITY = 1;

const connection = new Connection(RPC_ENDPOINT!, { wsEndpoint: RPC_WEBSOCKET_ENDPOINT, commitment: "confirmed" });
const mainKp = Keypair.fromSecretKey(base58.decode(PRIVATE_KEY!))

const main = async () => {
    try {
        const solBalance = await connection.getBalance(mainKp.publicKey);
        if (solBalance > 0) {
            console.log(
                "Wallet ",
                mainKp.publicKey.toBase58(),
                " SOL balance is ",
                (solBalance / 10 ** 9).toFixed(4)
            );
        }

        const tokenAccounts = await connection.getTokenAccountsByOwner(
            mainKp.publicKey,
            { programId: TOKEN_PROGRAM_ID },
            "confirmed"
        );

        const tokenDecimals = tokenAccounts
        const ixs: TransactionInstruction[] = [];
        const accounts: TokenAccount[] = [];
        console.log("Token Account counts:", tokenAccounts.value.length);

        if (tokenAccounts.value.length > 0) {
            for (const { pubkey, account } of tokenAccounts.value) {
                accounts.push({
                    pubkey,
                    programId: account.owner,
                    accountInfo: SPL_ACCOUNT_LAYOUT.decode(account.data),
                });
            }
        }

        for (let j = 0; j < accounts.length; j++) {

            if (accounts[j].accountInfo.mint.equals(new PublicKey("So11111111111111111111111111111111111111112"))) {
                continue;
            }
            const baseAta = await getAssociatedTokenAddress(
                accounts[j].accountInfo.mint,
                mainKp.publicKey
            );
            const tokenAccount = accounts[j].pubkey;
            const tokenBalance = (await connection.getTokenAccountBalance(accounts[j].pubkey)).value;

            if (tokenBalance.uiAmount !== null) {
                console.log("Token balance : ", tokenBalance.uiAmount);
            } else {
                console.log("Token balance unavailable, possibly empty account.");
                continue; // Skip this account
            }

            let i = 0;
            while (true) {
                if (i > 5) {
                    console.log("Sell error");
                    break;
                }
                if (!tokenBalance.uiAmount || tokenBalance.uiAmount == 0) {
                    break;
                }
                try {
                    const burnIx = createBurnCheckedInstruction(
                        accounts[j].pubkey, // PublicKey of Owner's Associated Token Account
                        new PublicKey(accounts[j].accountInfo.mint), // Token Mint Address
                        mainKp.publicKey, // Owner's Wallet
                        BigInt(tokenBalance.amount), // Tokens to burn
                        tokenBalance.decimals // Token Mint Decimals
                    );

                    if (!burnIx) {
                        throw new Error("Error getting sell transaction");
                    }

                    const { blockhash } = await connection.getLatestBlockhash("finalized");

                    const messageV0 = new TransactionMessage({
                        payerKey: mainKp.publicKey,
                        recentBlockhash: blockhash,
                        instructions: [burnIx],
                    }).compileToV0Message();

                    const transaction = new VersionedTransaction(messageV0);
                    transaction.sign([mainKp]);

                    logger.info("Simulating transaction...");
                    logger.info(await connection.simulateTransaction(transaction, { sigVerify: true, commitment: "confirmed" }));

                    const vSig = await connection.sendRawTransaction(transaction.serialize(), { skipPreflight: true });
                    await connection.confirmTransaction(vSig, "confirmed");

                    logger.info("Transaction signature: ", vSig);

                    let buysig = await sendBundle([transaction], mainKp, "processed", blockhash);
                    console.log("Bundle sent with signature: ", buysig);

                    break;
                } catch (error) {
                    console.log("Error in sell attempt", i + 1, ":", error);
                    i++;
                }
            }

            await sleep(1000);

            const tokenBalanceAfterSell = (await connection.getTokenAccountBalance(accounts[j].pubkey)).value;

            if (tokenBalanceAfterSell.uiAmount !== null && tokenBalanceAfterSell.uiAmount > 0) {
                console.log(
                    "Token Balance After Sell:",
                    mainKp.publicKey.toBase58(),
                    tokenBalanceAfterSell.amount
                );

                ixs.push(
                    createAssociatedTokenAccountIdempotentInstruction(
                        mainKp.publicKey,
                        baseAta,
                        mainKp.publicKey,
                        accounts[j].accountInfo.mint
                    )
                );

                ixs.push(
                    createTransferCheckedInstruction(
                        tokenAccount,
                        accounts[j].accountInfo.mint,
                        baseAta,
                        mainKp.publicKey,
                        BigInt(tokenBalanceAfterSell.amount),
                        tokenBalance.decimals
                    )
                );
            }

            ixs.push(createCloseAccountInstruction(tokenAccount, mainKp.publicKey, mainKp.publicKey));
        }

        if (ixs.length) {
            const tx = new Transaction().add(
                ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 }),
                ComputeBudgetProgram.setComputeUnitLimit({ units: 40_000 }),
                ...ixs
            );
            tx.feePayer = mainKp.publicKey;
            tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;

            console.log("Simulating final transaction...");
            console.log(await connection.simulateTransaction(tx), "\n");

            const sig = await sendAndConfirmTransaction(connection, tx, [mainKp], { commitment: "confirmed" });

            console.log(`Closed and sold tokens from wallet : https://solscan.io/tx/${sig}`);
            return;
        }

    } catch (error) {
        console.log("Transaction error while processing", error);
        return;
    }
};



main()