import dotenv from "dotenv";

dotenv.config();

export const config = {
  apiKey: process.env.OPENROUTER_API_KEY || "",
  model: process.env.MODEL || "deepseek/deepseek-v4.1-flash",
  systemPrompt:
    process.env.SYSTEM_PROMPT ||
    "You are a coding agent. Your job is to code. Always code.\nUse the bash tool and read_file to inspect files.\nAnswer back to the user once exploration is done.",
  provider: {
    only: ["together"],
    allowFallbacks: false
  }
};
