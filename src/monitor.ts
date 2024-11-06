import { Bot } from "./bot";
import { EtherscanAPI } from "./ether-scan";
import { logger } from "./logger";
import type { Config, EtherscanTx } from "./types";

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
    const BLOCK_RANGE_SIZE = 50; // Configurable range size
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
              await this.etherscanApi.getContractTransactions(
                address,
                this.contractStats[name].lastBlockChecked
              );

            // Limit to latest 5 transactions if more exist
            const limitedTransactions =
              transactions.length > limit
                ? transactions.slice(-limit) // Take last 5 transactions
                : transactions;

            return {
              name,
              transactions: limitedTransactions,
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

      // Step 2: Process transactions and prepare messages in parallel
      const processingPromises = contractTransactions
        .filter(({ transactions }) => transactions.length > 0)
        .map(async ({ name, transactions, totalFound, maxBlock }) => {
          try {
            console.log(
              `\nProcessing ${
                transactions.length
              } out of ${totalFound} transactions for ${name}${
                totalFound > limit ? " (limited to latest 5)" : ""
              }`
            );

            // Group transactions by block range instead of individual blocks
            const txsByRange = transactions.reduce(
              (acc: Record<string, EtherscanTx[]>, tx) => {
                const blockRange = getBlockRange(
                  parseInt(tx.blockNumber),
                  BLOCK_RANGE_SIZE
                );
                if (!acc[blockRange]) {
                  acc[blockRange] = [];
                }
                acc[blockRange].push(tx);
                return acc;
              },
              {}
            );

            // Process each block's transactions and prepare messages
            const messages: string[] = [];
            const copyWalletMessages: string[] = [];

            await Promise.all(
              Object.entries(txsByRange).map(async ([blockRange, rangeTxs]) => {
                // Sort transactions within range by block number
                rangeTxs.sort(
                  (a, b) => parseInt(a.blockNumber) - parseInt(b.blockNumber)
                );

                const totalEth = rangeTxs.reduce(
                  (sum, tx) => sum + parseFloat(tx.value) / 1e18,
                  0
                );
                const values = rangeTxs.map(
                  (tx) => parseFloat(tx.value) / 1e18
                );
                const pattern = this.detectPattern(values);

                messages.push(
                  this.createMessage(
                    name,
                    rangeTxs,
                    totalEth,
                    pattern,
                    blockRange,
                    getDateRange(rangeTxs).formattedRange
                  )
                );

                if (rangeTxs.length > 1) {
                  const minReceiver = this.findMinEthReceiver(rangeTxs);
                  copyWalletMessages.push(
                    `Wallet that received least ETH in range \`${blockRange}: ${minReceiver}\``
                  );
                }
              })
            );

            return {
              name,
              messages,
              copyWalletMessages,
              maxBlock: maxBlock ? maxBlock + 1 : currentBlock,
            };
          } catch (error) {
            console.error(`Error processing transactions for ${name}:`, error);
            return {
              name,
              messages: [] as string[],
              copyWalletMessages: [],
              maxBlock: this.contractStats[name].lastBlockChecked,
            };
          }
        });

      // Wait for all processing to complete
      const results = await Promise.all(processingPromises);

      // Step 3: Send messages in parallel and update block numbers
      await Promise.all(
        results.map(
          async ({ name, messages, copyWalletMessages, maxBlock }) => {
            const sendPromises: Promise<void>[] = [];

            if (messages.length > 0) {
              if (messages.length > 5) {
                messages.unshift(
                  `⚠️ Found ${messages.length} transactions. Showing latest 5 only.`
                );
              }
              sendPromises.push(
                this.bot.sendMessage(messages, this.config.MAIN_CHAT_ID)
              );
            }

            if (copyWalletMessages.length > 0) {
              sendPromises.push(
                this.bot.sendMessage(
                  copyWalletMessages,
                  this.config.COPY_WALLET_CHAT_ID
                )
              );
            }

            // Wait for messages to be sent
            await Promise.all(sendPromises);

            // Update last checked block
            this.contractStats[name].lastBlockChecked = maxBlock;
          }
        )
      );

      // Update contracts with no transactions
      contractTransactions
        .filter(({ transactions }) => transactions.length === 0)
        .forEach(({ name }) => {
          this.contractStats[name].lastBlockChecked = currentBlock;
          console.log(`No transactions found for ${name}`);
        });
    } catch (error: any) {
      console.error("Error in monitoring:", error.message);
    }
  }

  private createMessage(
    name: string,
    blockTxs: EtherscanTx[],
    totalEth: number,
    pattern: string,
    blockRange: string,
    timeStamp: string
  ): string {
    // Escape special characters for MarkdownV2
    const escapedPattern = pattern.replace(/[_*[\]()~`>#+\-=|{}.!]/g, "\\$&");

    return `*${name} Transaction Detected* 🔔

• 📊Block Range: \`${blockRange}\`
• Timestamp: \`${timeStamp}\`
• Total Transactions: \`${blockTxs.length}\`
• Total ETH: \`${totalEth.toFixed(4)} ETH\`
• Avg ETH per tx: \`${(totalEth / blockTxs.length).toFixed(4)}\`
• Pattern: \`${escapedPattern}\`

*Transaction: *
${blockTxs
  .map((tx) => {
    const ethValue = (parseFloat(tx.value) / 1e18).toFixed(4);
    return `• \`${ethValue} ETH\` → [View Wallet](https://etherscan.io/address/${tx.to})`;
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

  private findMinEthReceiver(transactions: EtherscanTx[]): string {
    const minTx = transactions.reduce((min, tx) =>
      parseFloat(tx.value) < parseFloat(min.value) ? tx : min
    );
    return minTx.to;
  }
}

// Helper function to group blocks into ranges
function getBlockRange(blockNumber: number, rangeSize: number = 50): string {
  const startBlock = Math.floor(blockNumber / rangeSize) * rangeSize;
  const endBlock = startBlock + rangeSize - 1;
  return `${startBlock}-${endBlock}`;
}

function getDateRange(transactions: EtherscanTx[]): {
  startDate: string;
  endDate: string;
  formattedRange: string;
} {
  if (!transactions.length) {
    return {
      startDate: "",
      endDate: "",
      formattedRange: "No transactions",
    };
  }

  const timestamps = transactions.map((tx) => parseInt(tx.timeStamp));
  const minTimestamp = Math.min(...timestamps);
  const maxTimestamp = Math.max(...timestamps);

  const startDate = new Date(minTimestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const endDate = new Date(maxTimestamp * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  const formattedRange =
    startDate === endDate ? startDate : `${startDate} - ${endDate}`;

  return {
    startDate,
    endDate,
    formattedRange,
  };
}
