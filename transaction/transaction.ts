
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Token, TokenAmount, Percent } from '@raydium-io/raydium-sdk';
import { ComputeBudgetProgram, Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction, createSyncNativeInstruction, getAccount, getAssociatedTokenAddress, getAssociatedTokenAddressSync, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import Client from '@triton-one/yellowstone-grpc';
import dotenv from 'dotenv'
import bs58 from 'bs58';

import { createPoolKeys, getTokenAccounts } from "../liquidity";
import { MinimalMarketLayoutV3 } from '../market';
import { executeJitoTx } from '../utils/srcutils/jito';
import { sleep } from '../utils/srcutils/commonFunc';
import { sendBundle } from '../utils/srcutils/liljito';
import { logger } from '../utils/logger';
import {
  COMMITMENT_LEVEL,
  LOG_LEVEL,
  PRIVATE_KEY,
  QUOTE_AMOUNT,
  QUOTE_MINT,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  TAKE_PROFIT,
  STOP_LOSS,
  SELL_SLIPPAGE,
  SKIP_SELLING_IF_LOST_MORE_THAN,
  MAX_SELL_RETRIES,
  PRICE_CHECK_INTERVAL,
  PRICE_CHECK_DURATION
} from "../constants";
import { sendAndConfirmTransaction } from '@solana/web3.js';
import { getSellTxWithJupiter } from '../utils';
import { executeJitoTx1 } from '../utils/juipiterjito';
// import { closeAllTokenAccounts } from '../utils/closeata';

dotenv.config()

let wallet: Keypair;
let quoteToken: Token;
let quoteTokenAssociatedAddress: PublicKey;
let quoteAmount: TokenAmount;
const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY!));

wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);

export interface MinimalTokenAccountData {
  mint: PublicKey;
  address: PublicKey;
  poolKeys?: LiquidityPoolKeysV4;
  market?: LiquidityStateV4;
};

const existingTokenAccounts: Map<string, MinimalTokenAccountData> = new Map<string, MinimalTokenAccountData>();

// Constants
const ENDPOINT = process.env.GRPC_ENDPOINT!;
const TOKEN = process.env.GRPC_TOKEN!;

const client = new Client(ENDPOINT, TOKEN, {});

const solanaConnection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
});
const stakeConnection = new Connection(RPC_ENDPOINT!, 'processed')

const AMOUNT_TO_WSOL = parseFloat(process.env.AMOUNT_TO_WSOL || '0.005');
const AUTO_SELL = process.env.AUTO_SELL === 'true';
const SELL_TIMER = parseInt(process.env.SELL_TIMER || '10000', 10);
const MAX_RETRY = parseInt(process.env.MAX_RETRY || '10', 10);
const SLIPPAGE = parseFloat(process.env.SLIPPAGE || '0.005');

// Init Function
export async function init(): Promise<void> {
  logger.level = LOG_LEVEL;

  // Get wallet
  wallet = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));
  logger.info(`Wallet Address: ${wallet.publicKey}`);

  // Handle quote token based on QUOTE_MINT (WSOL or USDC)
  switch (QUOTE_MINT) {
    case 'WSOL': {
      quoteToken = Token.WSOL;
      quoteAmount = new TokenAmount(Token.WSOL, QUOTE_AMOUNT, false);
      logger.info('Quote token is WSOL');
      break;
    }
    case 'USDC': {
      quoteToken = new Token(
        TOKEN_PROGRAM_ID,
        new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
        6,
        'USDC',
        'USDC',
      );
      quoteAmount = new TokenAmount(quoteToken, QUOTE_AMOUNT, false);
      logger.info('Quote token is USDC');
      break;
    }
    default: {
      throw new Error(`Unsupported quote mint "${QUOTE_MINT}". Supported values are USDC and WSOL`);
    }
  }

  logger.info(
    `Script will buy all new tokens using ${QUOTE_MINT}. Amount that will be used to buy each token is: ${quoteAmount.toFixed().toString()}`
  );

  // Display AUTO_SELL & SELL_TIMER
  logger.info(`AUTO_SELL: ${AUTO_SELL}`);
  logger.info(`SELL_TIMER: ${SELL_TIMER}`);
  logger.info(`SLIPPAGE: ${SLIPPAGE}`);
  logger.info(`AMOUNT_TO_WSOL: ${AMOUNT_TO_WSOL}`);
  logger.info(`MAX_RETRY: ${MAX_RETRY}`);
  logger.info(`CHECK_IF_FREEZABLE: ${process.env.CHECK_IF_FREEZABLE}`);

  // Check existing wallet for associated token account of quote mint
  const tokenAccounts = await getTokenAccounts(solanaConnection, wallet.publicKey, COMMITMENT_LEVEL);
  logger.info('Fetched token accounts from wallet.');

  // Create WSOL ATA and fund it with SOL during initialization
  if (QUOTE_MINT === 'WSOL') {
    const wsolAta = getAssociatedTokenAddressSync(Token.WSOL.mint, wallet.publicKey);
    logger.info(`WSOL ATA: ${wsolAta.toString()}`);

    // Check if WSOL account exists in wallet
    const solAccount = tokenAccounts.find(
      (acc) => acc.accountInfo.mint.toString() === Token.WSOL.mint.toString()
    );

    if (!solAccount) {
      logger.info(`No WSOL token account found. Creating and funding with ` + `${AMOUNT_TO_WSOL} SOL...`);

      // Create WSOL (wrapped SOL) account and fund it with SOL
      await createAndFundWSOL(wsolAta);
    } else {
      logger.info('WSOL account already exists in the wallet.');

      // Fetch the WSOL account balance
      const wsolAccountInfo = await getAccount(solanaConnection, wsolAta);
      const wsolBalance = Number(wsolAccountInfo.amount) / LAMPORTS_PER_SOL;
      logger.info(`Current WSOL balance: ${wsolBalance} WSOL`);

      // If WSOL balance is less than AMOUNT_TO_WSOL, top up the WSOL account
      if (wsolBalance < AMOUNT_TO_WSOL) {
        logger.info(`Insufficient WSOL balance. Funding with additional ` + `${AMOUNT_TO_WSOL} +  SOL...`);
        await createAndFundWSOL(wsolAta);
      }
    }

    // Set the quote token associated address
    quoteTokenAssociatedAddress = wsolAta;
  } else {
    const tokenAccount = tokenAccounts.find(
      (acc) => acc.accountInfo.mint.toString() === quoteToken.mint.toString()
    );

    if (!tokenAccount) {
      throw new Error(`No ${quoteToken.symbol} token account found in wallet: ${wallet.publicKey}`);
    }

    quoteTokenAssociatedAddress = tokenAccount.pubkey;
  }
}

// Helper function to create and fund WSOL account
async function createAndFundWSOL(wsolAta: PublicKey): Promise<void> {
  // Create WSOL (wrapped SOL) account and fund it
  const instructions = [
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
    ComputeBudgetProgram.setComputeUnitLimit({ units: 60000 }),
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      wsolAta,
      wallet.publicKey,
      Token.WSOL.mint
    ),
    SystemProgram.transfer({
      fromPubkey: wallet.publicKey,
      toPubkey: wsolAta,
      lamports: AMOUNT_TO_WSOL * LAMPORTS_PER_SOL,
    }),
    createSyncNativeInstruction(wsolAta), // Sync native to wrap SOL into WSOL
  ];

  // Prepare message and versioned transaction
  const latestBlockhash = await solanaConnection.getLatestBlockhash();
  logger.info('Fetched latest blockhash for transaction.');

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: instructions,
  }).compileToV0Message();

  const versionedTransaction = new VersionedTransaction(message);

  // Sign the transaction
  versionedTransaction.sign([wallet]);

  // Send the serialized transaction using sendRawTransaction
  const signature = await solanaConnection.sendRawTransaction(versionedTransaction.serialize(), {
    skipPreflight: false,
    preflightCommitment: COMMITMENT_LEVEL,
  });

  // Confirm transaction with the new `TransactionConfirmationStrategy`
  const confirmationStrategy = {
    signature,
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
  };

  await solanaConnection.confirmTransaction(confirmationStrategy, COMMITMENT_LEVEL);
  logger.info(`Created and funded WSOL account with ` + AMOUNT_TO_WSOL + ` SOL. Transaction signature: ${signature}`);
}


// Helper function to check if freeze authority exists
async function checkFreezeAuthority(mintAddress: PublicKey): Promise<boolean> {
  const mintAccountInfo = await solanaConnection.getAccountInfo(mintAddress);
  if (mintAccountInfo && mintAccountInfo.data) {
    const mintData = MintLayout.decode(mintAccountInfo.data);
    logger.info("mintAccountInfo ====>", mintAccountInfo)
    logger.info("mintData ====>", mintData)
    return mintData.freezeAuthorityOption !== 0;
  }
  return false;
}


export async function buy(
  tokenMint: PublicKey,
  poolState: LiquidityStateV4,
  minimalMarketLayoutV3: MinimalMarketLayoutV3
): Promise<{ solBuyPrice: number | null; poolKeys: any } | null> {
  // const client = new Client(ENDPOINT, TOKEN, {});
  // const latestBlockhash = await client.getLatestBlockhash();
  // await sleep(1000)

  const latestBlockhash = await solanaConnection.getLatestBlockhash();
  try {
    const mintAddress = poolState.baseMint;
    const shouldCheckFreezeAuthority = process.env.FREEZE_AUTHORITY === 'true';
    let transaction = new Transaction();

    if (shouldCheckFreezeAuthority) {
      const freezeAuthorityExists = await checkFreezeAuthority(mintAddress);
      if (freezeAuthorityExists) {
        logger.info(`Freeze authority exists for token mint: ${mintAddress.toString()}. Skipping buy.`);
        return null;
      }
      logger.info(`No freeze authority for token mint: ${mintAddress.toString()}. Proceeding to buy.`);
    } else {
      logger.info(`FREEZE_AUTHORITY is disabled. Skipping freeze authority check and proceeding to buy.`);
    }

    const tokenAta = getAssociatedTokenAddressSync(mintAddress, keypair.publicKey);
    const poolKeys = createPoolKeys(tokenMint, poolState, minimalMarketLayoutV3);

    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: quoteTokenAssociatedAddress,
          tokenAccountOut: tokenAta,
          owner: keypair.publicKey,
        },
        amountIn: quoteAmount.raw,
        minAmountOut: 0,
      },
      poolKeys.version,
    );




    // legacy transaction 
    transaction
      .add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 200000 }))
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }))
      .add(
        createAssociatedTokenAccountIdempotentInstruction(
          keypair.publicKey,
          tokenAta,
          keypair.publicKey,
          mintAddress,
        ),
      )
      .add(...innerTransaction.instructions);

    transaction.feePayer = keypair.publicKey;
    transaction.recentBlockhash = latestBlockhash.blockhash;

    // logger.info(await solanaConnection.simulateTransaction(transaction))
    // const sig = await sendAndConfirmTransaction(solanaConnection, transaction, [keypair], { commitment: "confirmed" })
    // logger.info("Signature from legacy transaction : ", sig)






    // versioned transaction
    const messageV0 = new TransactionMessage({
      payerKey: keypair.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
        ComputeBudgetProgram.setComputeUnitLimit({ units: 60000 }),
        createAssociatedTokenAccountIdempotentInstruction(
          keypair.publicKey,
          tokenAta,
          keypair.publicKey,
          mintAddress,
        ),
        ...innerTransaction.instructions,
      ],
    }).compileToV0Message();

    const versionedTx = new VersionedTransaction(messageV0);
    versionedTx.sign([keypair]);
    logger.info(await solanaConnection.simulateTransaction(versionedTx, { sigVerify: true, commitment: 'confirmed' }));
    const vSig = await solanaConnection.sendRawTransaction(versionedTx.serialize(), { skipPreflight: true })
    await solanaConnection.confirmTransaction(vSig, "confirmed")
    logger.info("signature of versioned transaction: ", bs58.encode(versionedTx.signatures[0]))


    let buysig = await sendBundle([versionedTx], keypair, 'processed', latestBlockhash);
    // let buysig = await executeJitoTx([versionedTx], keypair, 'processed', latestBlockhash);


    // const tokenAta = await getAssociatedTokenAddress(mintAddress, keypair.publicKey);
    // const tokenAccountInfo = await getAccount(solanaConnection, tokenAta, "processed");



    // const solBuyPrice = Number(QUOTE_AMOUNT) / Number(tokenAccountInfo.amount) * 10 ** 9;

    // if (Number(tokenAccountInfo?.amount) !== 0) {
    //   logger.info("Token balance is updated successfully", '\n');
    //   logger.info("solBuyPrice ============>", solBuyPrice);
    //   return { solBuyPrice, poolKeys };
    // } else {
    //   logger.info("Token balance is not updated", '\n');
    //   throw new Error("Token balance failed to update.");
    // }

    // throw new Error("Jito transaction failed.");

    await sleep(2000)
    const INTERVAL_TIME = 50; // Interval for checking (10ms)
    const MAX_WAIT_TIME = 2000; // Maximum wait time (5 seconds)
    const startTime = Date.now(); // Record the start time

    while (true) {
      // Get the current time to check against MAX_WAIT_TIME
      const currentTime = Date.now();

      // Exit the loop and throw an error if the maximum time is exceeded
      if (currentTime - startTime > MAX_WAIT_TIME) {
        logger.info("Token balance is not updated within the maximum wait time");
        throw new Error("Token balance failed to update within the specified time.");
      }

      // Fetch token account info
      const tokenAta = await getAssociatedTokenAddress(mintAddress, keypair.publicKey);
      const tokenAccountInfo = await getAccount(solanaConnection, tokenAta, "processed");
      logger.info("🚀 ~ tokenInfo:", tokenAccountInfo);
      logger.info("🚀 ~ tokenBalance:", tokenAccountInfo.amount);

      // Check if token amount is non-zero
      if (Number(tokenAccountInfo?.amount) !== 0) {
        logger.info("------------------------- Buy Token successful ------------------------");
        const solBuyPrice = Number(QUOTE_AMOUNT) / Number(tokenAccountInfo.amount) * 10 ** 9;

        logger.info("Token balance is updated successfully");
        logger.info("solBuyPrice ============>", solBuyPrice);
        return { solBuyPrice, poolKeys }; // Return result when amount != 0
      }

      // Wait for the specified interval before checking again
      await new Promise(resolve => setTimeout(resolve, INTERVAL_TIME));
    }
  } catch (error) {
    logger.error(error);
    return null;
  }
}



export async function sellToken(poolState: LiquidityStateV4, buyprice: number, poolKeys: LiquidityPoolKeysV4) {
  try {

    if (!AUTO_SELL) {
      logger.info("Auto sell is disabled");
      return;
    }

    let retries = 0;
    let startTime = Date.now();
    let mintAddress = poolState.baseMint;
    const ata = getAssociatedTokenAddressSync(mintAddress, wallet.publicKey);

    while (true) {
      try {
        const poolBaseTokenAccountInfo = await getAccount(solanaConnection, poolState.baseVault, "processed");
        const poolBaseTokenBalance = poolBaseTokenAccountInfo.amount;
        // logger.info("🚀 ~ Pool base tokenInfo:", poolBaseTokenAccountInfo);
        logger.info("🚀 ~ Pool base tokenBalance:", poolBaseTokenBalance);

        const poolQuateTokenAccountInfo = await getAccount(solanaConnection, poolState.quoteVault, "processed");
        const poolQuateTokenBalance = poolQuateTokenAccountInfo.amount;
        // logger.info("🚀 ~ Pool quate tokenInfo:", poolQuateTokenAccountInfo);
        logger.info("🚀 ~ Pool quate tokenBalance:", poolQuateTokenBalance);

        const poolTokenPrice = Number(poolQuateTokenBalance) / Number(poolBaseTokenBalance);
        logger.info("🚀 ~ poolTokenPrice:", poolTokenPrice);

        const priceChange = ((poolTokenPrice - buyprice) / buyprice) * 100;
        logger.info("priceChange =====>", priceChange);

        logger.info(`Current price: ${poolTokenPrice}, Buy price: ${buyprice}, Price change: ${priceChange.toFixed(3)}%`);

        if (priceChange >= TAKE_PROFIT) {
          logger.info("Take profit condition met");
          break;
        }
        if (priceChange <= -STOP_LOSS) {
          logger.info("Stop loss condition met");
          break;
        }
        if (priceChange <= -SKIP_SELLING_IF_LOST_MORE_THAN) {
          logger.info(`Skip selling, price drop exceeded threshold: ${SKIP_SELLING_IF_LOST_MORE_THAN}%`);
          return;
        }
        if (PRICE_CHECK_DURATION && Date.now() - startTime > PRICE_CHECK_DURATION) {
          logger.info("Price check duration exceeded, proceeding to sell");
          break;
        }
        await new Promise(resolve => setTimeout(resolve, PRICE_CHECK_INTERVAL));
      } catch (error) {
        logger.info("Error in price monitoring", error);
      }
    }

    while (retries < MAX_SELL_RETRIES) {
      try {
        logger.info(`Attempt ${retries + 1} to sell token`);
        let sellSig = await sell(wallet.publicKey, { mint: mintAddress, address: ata }, poolState, poolKeys);
        if (sellSig) {
          logger.info("Token sold finish");
          return true;
        }
        break;
      } catch (err) {
        retries++;
        logger.info(`Sell attempt failed (${retries}/${MAX_SELL_RETRIES})`, err);
        if (retries >= MAX_SELL_RETRIES) {
          logger.info("Max sell retries reached, aborting");
        }
      }
    }
    logger.info("sell token")

  } catch (error) {
    console.error(error)
  }
}

export const sell = async (
  accountId: PublicKey,
  rawAccount: MinimalTokenAccountData,
  poolState: LiquidityStateV4,
  poolKeys: LiquidityPoolKeysV4
) => {
  logger.info(`Sell function triggered for account: ${accountId.toString()}`);

  try {
    logger.info({ mint: rawAccount.mint }, `Processing sell for token...`);

    // Get the associated token account for the mint
    let ata: PublicKey;
    let tokenAccountInfo: any;
    const maxRetries = MAX_RETRY;
    const delayBetweenRetries = 2000; // 2 seconds delay between retries

    ata = getAssociatedTokenAddressSync(rawAccount.mint, wallet.publicKey);

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        tokenAccountInfo = await getAccount(solanaConnection, ata);
        break; // Break the loop if fetching the account was successful
      } catch (error) {
        if (error instanceof Error && error.name === 'TokenAccountNotFoundError') {
          logger.info(`Attempt ${attempt + 1}/${maxRetries}: Associated token account not found, retrying...`);
          if (attempt === maxRetries - 1) {
            logger.error(`Max retries reached. Failed to fetch the token account.`);
            throw error;
          }
          // Wait before retrying
          await new Promise((resolve) => setTimeout(resolve, delayBetweenRetries));
        } else if (error instanceof Error) {
          logger.error(`Unexpected error while fetching token account: ${error.message}`);
          throw error;
        } else {
          logger.error(`An unknown error occurred: ${String(error)}`);
          throw error;
        }
      }
    }

    // If tokenAccountInfo is still undefined after retries, create the associated token account
    if (!tokenAccountInfo) {
      logger.info(`Creating associated token account for mint: ${rawAccount.mint.toString()}...`);
      const transaction = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: (await solanaConnection.getLatestBlockhash()).blockhash,
        instructions: [
          createAssociatedTokenAccountIdempotentInstruction(
            wallet.publicKey,
            ata,
            wallet.publicKey,
            rawAccount.mint,
          ),
        ],
      }).compileToV0Message();

      const createAtaTx = new VersionedTransaction(transaction);
      createAtaTx.sign([wallet]);

      const signature = await solanaConnection.sendRawTransaction(createAtaTx.serialize());
      await solanaConnection.confirmTransaction(signature);
      logger.info(`Created associated token account with signature: ${signature}`);

      // Fetch the newly created token account
      tokenAccountInfo = await getAccount(solanaConnection, ata);
    }

    // Fetch the token balance after ensuring the account exists
    const tokenBalance = tokenAccountInfo.amount.toString();
    logger.info(`Token balance for ${rawAccount.mint.toString()} is: ${tokenBalance}`);

    if (tokenBalance === '0') {
      logger.info({ mint: rawAccount.mint.toString() }, `Empty balance, can't sell`);
      return;
    }

    const tokenIn = new Token(TOKEN_PROGRAM_ID, rawAccount.mint, poolState.baseDecimal.toNumber());
    const tokenAmountIn = new TokenAmount(tokenIn, tokenBalance, true); // Use the entire balance

    // Fetch pool info
    const poolInfo = await Liquidity.fetchInfo({
      connection: solanaConnection,
      poolKeys,
    });

    if (poolInfo) {
      logger.info(`Pool status: ${poolInfo.status.toString()}`);
      logger.info(`Base decimals: ${poolInfo.baseDecimals}`);
      logger.info(`Quote decimals: ${poolInfo.quoteDecimals}`);
      logger.info(`Base reserve: ${poolInfo.baseReserve.toString()}`);
      logger.info(`Quote reserve: ${poolInfo.quoteReserve.toString()}`);
      logger.info(`LP supply: ${poolInfo.lpSupply.toString()}`);
      logger.info(`Trading Open time: ${poolInfo.startTime.toString()}`);
    } else {
      logger.error('Failed to fetch pool info.');
    }

    // Use poolKeys
    let swapFlag = await swap(
      poolKeys,
      ata, // Use the associated token account (ata) for the swap
      quoteTokenAssociatedAddress,
      tokenIn,
      quoteToken,
      tokenAmountIn,
      wallet,
      'sell'
    );

    if (swapFlag) { return true }
    else return false;
  } catch (error) {
    logger.error({ mint: rawAccount.mint.toString(), error }, `Failed to sell token`);
    return false
  }
};


// Swap Function
async function swap(
  poolKeys: LiquidityPoolKeysV4,
  ataIn: PublicKey, // Token you're selling
  ataOut: PublicKey, // Token you're receiving (quoteToken)
  tokenIn: Token,
  tokenOut: Token,
  amountIn: TokenAmount,
  wallet: Keypair,
  direction: 'buy' | 'sell',
) {
  // Convert slippage into a percentage (500 means 0.5%)
  const slippagePercent = new Percent(Math.round(SLIPPAGE * 10000), 10000);

  // Fetch pool info
  const poolInfo = await Liquidity.fetchInfo({
    connection: solanaConnection,
    poolKeys,
  });

  // Compute the minimum amount out (taking slippage into account)
  const computedAmountOut = Liquidity.computeAmountOut({
    poolKeys,
    poolInfo,
    amountIn,
    currencyOut: tokenOut,
    slippage: slippagePercent,
  });

  const latestBlockhash = await solanaConnection.getLatestBlockhash();
  const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
    {
      poolKeys: poolKeys,
      userKeys: {
        tokenAccountIn: ataIn,
        tokenAccountOut: ataOut,
        owner: wallet.publicKey,
      },
      amountIn: amountIn.raw,
      minAmountOut: computedAmountOut.minAmountOut.raw,
    },
    poolKeys.version,
  );

  const messageV0 = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 50000 }),
      ...innerTransaction.instructions,
      ...(direction === 'sell' ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []), // Close account if selling
    ],
  }).compileToV0Message();

  // Sign and execute the transaction
  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([wallet, ...innerTransaction.signers]);

  const signature = await solanaConnection.sendRawTransaction(transaction.serialize(), {
    skipPreflight: true,
  });
  logger.info(`Transaction ${direction} with signature - ${signature}`);
  return true;
}



export async function sellWithJupiter(tokenMint: PublicKey) {
  try {
    console.log("🚀 Initiating Sell Transaction via Jupiter...");

    console.log("tokenMint============>", tokenMint)
    // Ensure wallet is connected
    if (!wallet?.publicKey) {
      throw new Error("❌ Wallet not connected or undefined.");
    }

    // Fetch associated token account
    const tokenAccount = await getAssociatedTokenAddress(tokenMint, wallet.publicKey);
    console.log("tokenAccount===========>", tokenAccount);
    // Fetch token balance (as a string)
    const tokenBalanceStr = (await solanaConnection.getTokenAccountBalance(tokenAccount)).value.amount;
    console.log("tokenBalanceStr===========>", tokenBalanceStr);

    // Convert balance to number safely
    const tokenBalance = Number(tokenBalanceStr);
    if (!tokenBalance || tokenBalance <= 0) {
      console.warn("⚠️ No tokens available to sell.");
      return;
    }

    console.log(`📊 Selling ${tokenBalance} tokens...`);

    // Get swap transaction from Jupiter
    const tokenSellTx = await getSellTxWithJupiter(wallet, tokenMint, tokenBalance);
    if (!tokenSellTx) {
      console.error("❌ Failed to get swap transaction from Jupiter.");
      return;
    }

    // Execute transaction with Jito
    const txSig = await executeJitoTx1([tokenSellTx], wallet, "confirmed");
    console.log(`✅ Successfully swapped tokens. Transaction Signature: ${txSig}`);
    // await closeAllTokenAccounts()

  } catch (error) {
    console.error("🔥 Error in sellWithJupiter:", error);
  }
}
