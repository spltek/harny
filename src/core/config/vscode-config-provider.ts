import { workspace, type WorkspaceConfiguration } from "vscode";
import {
  DEFAULT_CONFIG,
  isThinkingLevel,
  isThinkingMode,
  type ConfigProvider,
  type HarnyConfig,
} from "./types";

/**
 * Reads configuration from VS Code settings (harny.*) with env-var fallback.
 */
export class VscodeConfigProvider implements ConfigProvider {
  private load(): WorkspaceConfiguration {
    return workspace.getConfiguration("harny");
  }

  get(): HarnyConfig {
    const cfg = this.load();
    const apiKey = cfg.get<string>("apiKey", "") || process.env.OPENAI_API_KEY || "";
    return {
      provider: cfg.get<HarnyConfig["provider"]>("provider", DEFAULT_CONFIG.provider),
      apiKey,
      baseUrl: cfg.get<string>("baseUrl", DEFAULT_CONFIG.baseUrl),
      model: cfg.get<string>("model", DEFAULT_CONFIG.model),
      maxTokens: cfg.get<number>("maxTokens", DEFAULT_CONFIG.maxTokens),
      temperature: cfg.get<number | undefined>("temperature", DEFAULT_CONFIG.temperature),
      contextFiles: cfg.get<boolean>("contextFiles", DEFAULT_CONFIG.contextFiles),
      autoApprove: cfg.get<boolean>("autoApprove", DEFAULT_CONFIG.autoApprove),
      autoOpen: cfg.get<boolean>("autoOpen", DEFAULT_CONFIG.autoOpen),
      subagentMaxTurns: cfg.get<number | undefined>("subagentMaxTurns", undefined),
      enableThinking: cfg.get<boolean | undefined>("enableThinking", undefined),
      thinkingMode: (() => {
        const v = cfg.get<unknown>("thinkingMode", undefined);
        return isThinkingMode(v) ? v : undefined;
      })(),
      thinkingLevel: (() => {
        const v = cfg.get<unknown>("thinkingLevel", undefined);
        return isThinkingLevel(v) ? v : undefined;
      })(),
    };
  }
}
