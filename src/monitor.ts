import { AssetTransfersCategory } from "alchemy-sdk";
import { Bot } from "./bot";
import { alchemy, EtherscanAPI } from "./ether-scan";
import { logger } from "./logger";
import type { Config, EtherscanTxInternal } from "./types";
import { sleep } from "bun";

interface PatternAnalysis {
  type:
    | "geometric"
    | "stepped"
    | "high-precision"
    | "varied"
    | "uniform"
    | "unknown";
  startValue: number;
  endValue: number;
  precision: number;
  ratio?: number;
  increment?: number;
  range: "start" | "middle" | "end" | "unknown";
}

export class TransactionMonitor {
  private bot: Bot; // NOTE: can only send 10 messages per second
  private blocksPerDay: number;
  private initialBlocksToFetch: number;
  private contractStats: Record<string, any>;
  private etherscanApi: EtherscanAPI;
  private config: Config;
  private minTransactions = 20;

  constructor(config: Config) {
    this.config = config;
    this.etherscanApi = new EtherscanAPI(config.ETHERSCAN_API_KEY);
    this.bot = new Bot(config.TELEGRAM_BOT_TOKEN);
    this.blocksPerDay = 7200;
    this.initialBlocksToFetch =
      config.INITIAL_DAYS_TO_MONITOR * this.blocksPerDay;
    this.contractStats = {};
    // Track last checked block separately for each contract
    this.contractStats = {};
    Object.keys(config.ADDRESS).forEach((name) => {
      this.contractStats[name] = {
        lastBlockChecked: 0,
        totalTransactions: 0,
        lastTransaction: null,
        firstSeen: null,
      };
    });
  }

  async start() {
    console.log(`Starting contract monitoring...`);
    console.log(
      `Monitoring period: ${this.config.INITIAL_DAYS_TO_MONITOR} days`
    );
    console.log(`Polling interval: ${this.config.POLLING_INTERVAL} seconds`);

    await this.monitorContracts();

    setInterval(async () => {
      await this.monitorContracts();
    }, this.config.POLLING_INTERVAL * 1000);
  }

  // 5 calls/second
  private async monitorContracts() {
    try {
      const currentBlock = await this.etherscanApi.getLatestBlock();
      if (!currentBlock) return;
      logger.info(`Latest block: ${currentBlock}`);

      // Initialize start blocks if needed
      for (const [name, _] of Object.entries(this.config.ADDRESS)) {
        if (this.contractStats[name].lastBlockChecked === 0) {
          this.contractStats[name].lastBlockChecked =
            currentBlock - this.initialBlocksToFetch;
        }
      }
      const limit = parseInt(process.env.LIMIT_TRANSACTIONS!);

      // Step 1: Fetch all transactions in parallel
      const transactionPromises = Object.entries(this.config.ADDRESS).map(
        async ([name, address]) => {
          try {
            const transactions =
              await this.etherscanApi.getInternalTransactions(
                address,
                this.contractStats[name].lastBlockChecked
              );

            return {
              name,
              transactions,
              totalFound: transactions.length,
              maxBlock:
                transactions.length > 0
                  ? Math.max(
                      ...transactions.map((tx) => parseInt(tx.blockNumber))
                    )
                  : null,
            };
          } catch (error) {
            console.error(`Error fetching transactions for ${name}:`, error);
            return {
              name,
              transactions: [],
              totalFound: 0,
              maxBlock: null,
            };
          }
        }
      );

      // Wait for all transaction fetches to complete
      const contractTransactions = await Promise.all(transactionPromises);

      let noOfCalls = 0;
      const results = [];

      // Process each contract's transactions sequentially
      for (const {
        name,
        transactions,
        totalFound,
        maxBlock,
      } of contractTransactions.filter(
        ({ transactions }) => transactions.length > 0
      )) {
        try {
          console.log(
            `\nProcessing ${
              transactions.length
            } out of ${totalFound} transactions for ${name}${
              totalFound > limit ? " (limited to latest 5)" : ""
            }`
          );

          // Group transactions by block
          const txsByBlock = transactions.reduce(
            (acc: Record<string, EtherscanTxInternal[]>, tx) => {
              if (!acc[tx.blockNumber]) {
                acc[tx.blockNumber] = [];
              }
              acc[tx.blockNumber].push(tx);
              return acc;
            },
            {}
          );

          console.log(
            `Found ${
              Object.keys(txsByBlock).length
            } blocks and block is ${Object.keys(txsByBlock)}`
          );

          // Process each block's transactions and prepare messages
          const messages: string[] = [];
          const copyWalletMessages: string[] = [];

          // Process blocks sequentially
          for (const [blockNum, blockTxs] of Object.entries(txsByBlock)) {
            if (
              blockTxs.length >= this.minTransactions &&
              blockTxs.every(
                (tx) =>
                  parseFloat(tx.value) / 1e18 >=
                  this.config.MIN_TRANSACTION_AMOUNT
              )
            ) {
              const randomWallets = blockTxs
                .map((tx) => tx.to)
                .filter((value, index, self) => self.indexOf(value) === index)
                .sort(() => Math.random() - 0.5)
                .slice(0, 2);

              // Rate limiting for API calls
              if (noOfCalls >= 10) {
                console.log("Too many calls, waiting for 1 sec");
                await sleep(1100);
                noOfCalls = 0;
              }
              noOfCalls++;

              const isOldWallet = await this.checkOldTransactions(
                // do 2 api calls per block
                randomWallets,
                blockTxs[0].from
              );

              if (isOldWallet) {
                console.log(
                  `Old wallet detected: ${blockTxs[0].to} with hash ${blockTxs[0].hash}`
                );
                continue;
              }

              // Process valid transactions
              console.log(
                `Processing block ${blockNum} with ${blockTxs.length} transactions`
              );
              const totalEth = blockTxs.reduce(
                (sum, tx) => sum + parseFloat(tx.value) / 1e18,
                0
              );
              const values = blockTxs.map((tx) => parseFloat(tx.value) / 1e18);
              const pattern = this.detectPattern(values);

              const msg = this.createMessage(
                name,
                blockTxs,
                blockNum,
                totalEth,
                pattern
              );

              if (msg.length > 4096) {
                // divide into multiple messages
                const chunks = this.splitMessage(msg);
                messages.push(...chunks);
              } else {
                messages.push(msg);
              }

              const minReceiver = this.findMinEthReceiver(blockTxs);
              copyWalletMessages.push(
                `Wallet that received least ETH in block ${minReceiver.block} : \`${minReceiver.value} ETH\` → \`${minReceiver.to}\` [View Wallet](https://app.zerion.io/${minReceiver.to}/history)`
              );
            }
          }

          results.push({
            name,
            messages,
            copyWalletMessages,
            maxBlock: maxBlock ? maxBlock + 1 : currentBlock,
          });
        } catch (error) {
          console.error(`Error processing transactions for ${name}:`, error);
          results.push({
            name,
            messages: [],
            copyWalletMessages: [],
            maxBlock: this.contractStats[name].lastBlockChecked,
          });
        }
      }

      // Step 3: Send messages sequentially and update block numbers
      for (const { name, messages, copyWalletMessages, maxBlock } of results) {
        try {
          if (messages.length > 0) {
            await this.bot.sendMessage(messages, this.config.MAIN_CHAT_ID);
          }

          if (copyWalletMessages.length > 0) {
            await this.bot.sendMessage(
              copyWalletMessages,
              this.config.COPY_WALLET_CHAT_ID
            );
          }

          // Update last checked block
          this.contractStats[name].lastBlockChecked = maxBlock;
        } catch (error) {
          console.error(`Error processing results for ${name}:`, error);
        }
      }

      // Update contracts with no transactions
      contractTransactions
        .filter(({ transactions }) => transactions.length === 0)
        .forEach(({ name }) => {
          this.contractStats[name].lastBlockChecked = currentBlock;
          console.log(
            `No transactions found for ${name} in block ${currentBlock}`
          );
        });
    } catch (error: any) {
      console.error("Error in monitoring:", error.message);
    }
  }

  private splitMessage(msg: string, maxLength: number = 4096): string[] {
    if (msg.length <= maxLength) return [msg];

    const messages: string[] = [];
    let currentMsg = "";

    // Split the message into header and transactions
    const [header, ...txLines] = msg.split("\n\n*Transaction: *\n");
    currentMsg = header + "\n\n*Transaction: *\n";

    // Process transaction lines
    const transactions = txLines[0].split("\n");

    for (const tx of transactions) {
      // Check if adding this transaction would exceed the limit
      if ((currentMsg + tx + "\n").length > maxLength) {
        messages.push(currentMsg.trim());
        // Start new message without header
        currentMsg = tx + "\n";
      } else {
        currentMsg += tx + "\n";
      }
    }

    if (currentMsg.trim().length > 0) {
      messages.push(currentMsg.trim());
    }

    return messages;
  }

  private async checkOldTransactions(
    wallets: string[],
    address: string
  ): Promise<boolean> {
    try {
      for (const wallet of wallets) {
        const transactions = await alchemy.core.getAssetTransfers({
          fromAddress: address,
          toAddress: wallet,
          excludeZeroValue: true,
          category: [AssetTransfersCategory.INTERNAL],
        });

        if (transactions.transfers.length > 1) {
          return true;
        }
      }
      return false;
    } catch (error) {
      console.error("Error checking old transactions:", error);
      return false;
    }
  }

  private createMessage(
    name: string,
    blockTxs: EtherscanTxInternal[],
    blockNum: string,
    totalEth: number,
    pattern: string
  ): string {
    // Escape special characters for MarkdownV2
    const escapedPattern = pattern.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

    return `*${name} Transaction Detected* 🔔

• Block Number: \`${blockNum}\`
• Timestamp: \`${new Date(
      parseInt(blockTxs[0].timeStamp) * 1000
    ).toLocaleString()}\`
• Total Transactions: \`${blockTxs.length}\`
• Total ETH: \`${totalEth.toFixed(4)} ETH\`
• Avg ETH per tx: \`${(totalEth / blockTxs.length).toFixed(4)}\`
• Pattern: \`${escapedPattern}\`

*Transaction: *
${blockTxs
  .map((tx) => {
    const ethValue = (parseFloat(tx.value) / 1e18).toFixed(4);
    return `• \`${ethValue} ETH\` → [View Wallet](https://app.zerion.io/${tx.to}/history)`;
  })
  .join("\n")}`;
  }

  private detectPattern(values: number[]): string {
    if (values.length < 2) return "unknown";

    const analysis = this.analyzePattern(values);

    return this.formatPatternDescription(analysis);
  }

  private analyzePattern(values: number[]): PatternAnalysis {
    const sorted = [...values].sort((a, b) => a - b);
    const startValue = sorted[0];
    const endValue = sorted[sorted.length - 1];
    const precision = this.calculatePrecision(values);

    // Check for uniform distribution
    if (this.isUniform(values)) {
      return {
        type: "uniform",
        startValue,
        endValue,
        precision,
        range: this.determineRange(startValue),
      };
    }

    // Check for geometric progression
    const geoRatio = this.checkGeometricProgression(sorted);
    if (geoRatio) {
      const type = precision > 8 ? "high-precision" : "geometric";
      return {
        type,
        startValue,
        endValue,
        precision,
        ratio: geoRatio,
        range: this.determineRange(startValue),
      };
    }

    // Check for stepped distribution
    const increment = this.checkSteppedDistribution(sorted);
    if (increment) {
      return {
        type: "stepped",
        startValue,
        endValue,
        precision,
        increment,
        range: this.determineRange(startValue),
      };
    }

    return {
      type: "varied",
      startValue,
      endValue,
      precision,
      range: this.determineRange(startValue),
    };
  }

  private isUniform(values: number[]): boolean {
    const epsilon = 1e-15; // Tolerance for floating-point comparison
    return values.every((v) => Math.abs(v - values[0]) < epsilon);
  }

  private checkGeometricProgression(sorted: number[]): number | null {
    if (sorted.length < 2) return null;

    const ratio = sorted[1] / sorted[0];
    const epsilon = sorted[0] > 0.1 ? 1e-8 : 1e-15; // Adjust precision based on value magnitude

    for (let i = 1; i < sorted.length; i++) {
      const currentRatio = sorted[i] / sorted[i - 1];
      if (Math.abs(currentRatio - ratio) > epsilon) {
        return null;
      }
    }

    return ratio;
  }

  private checkSteppedDistribution(sorted: number[]): number | null {
    if (sorted.length < 2) return null;

    const increment = sorted[1] - sorted[0];
    const epsilon = 1e-8;

    for (let i = 1; i < sorted.length; i++) {
      const currentIncrement = sorted[i] - sorted[i - 1];
      if (Math.abs(currentIncrement - increment) > epsilon) {
        return null;
      }
    }

    return increment;
  }

  private calculatePrecision(values: number[]): number {
    return Math.max(
      ...values.map((v) => {
        const decimalPart = v.toString().split(".")[1] || "";
        return decimalPart.length;
      })
    );
  }

  private determineRange(
    value: number
  ): "start" | "middle" | "end" | "unknown" {
    if (value >= 0.027 && value <= 0.045) return "start";
    if (value >= 0.05 && value <= 0.15) return "middle";
    if (value >= 0.15 && value <= 0.38) return "end";
    return "unknown";
  }

  private formatPatternDescription(analysis: PatternAnalysis): string {
    const rangeDesc =
      analysis.range !== "unknown" ? ` (${analysis.range} range)` : "";

    switch (analysis.type) {
      case "high-precision":
        return `high-precision geometric${rangeDesc} (ratio: ${analysis.ratio?.toFixed(
          4
        )}, ${analysis.precision} decimals)`;
      case "geometric":
        return `geometric${rangeDesc} (ratio: ${analysis.ratio?.toFixed(4)})`;
      case "stepped":
        return `stepped${rangeDesc} (increment: ${analysis.increment?.toFixed(
          4
        )} ETH)`;
      case "uniform":
        return `uniform${rangeDesc} (${analysis.startValue.toFixed(4)} ETH)`;
      default:
        return `varied${rangeDesc} (${analysis.startValue.toFixed(
          4
        )} ETH → ${analysis.endValue.toFixed(4)} ETH)`;
    }
  }

  private findMinEthReceiver(transactions: EtherscanTxInternal[]): {
    to: string;
    value: string;
    block: string;
  } {
    const minTx = transactions.reduce((min, tx) =>
      parseFloat(tx.value) < parseFloat(min.value) ? tx : min
    );
    return {
      to: minTx.to,
      value: (parseFloat(minTx.value) / 1e18).toFixed(4),
      block: minTx.blockNumber,
    };
  }
}
