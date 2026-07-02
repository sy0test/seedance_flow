/**
 * newapi GPT-Image 2 供应商适配
 * @version 1.1
 */

// ============================================================
// 类型定义
// ============================================================

type VideoMode =
  | "singleImage"
  | "startEndRequired"
  | "endFrameOptional"
  | "startFrameOptional"
  | "text"
  | (`videoReference:${number}` | `imageReference:${number}` | `audioReference:${number}`)[];

interface TextModel {
  name: string;
  modelName: string;
  type: "text";
  think: boolean;
}

interface ImageModel {
  name: string;
  modelName: string;
  type: "image";
  mode: ("text" | "singleImage" | "multiReference")[];
  associationSkills?: string;
}

interface VideoModel {
  name: string;
  modelName: string;
  type: "video";
  mode: VideoMode[];
  associationSkills?: string;
  audio: "optional" | false | true;
  durationResolutionMap: { duration: number[]; resolution: string[] }[];
}

interface TTSModel {
  name: string;
  modelName: string;
  type: "tts";
  voices: { title: string; voice: string }[];
}

interface VendorConfig {
  id: string;
  version: string;
  name: string;
  author: string;
  description?: string;
  icon?: string;
  inputs: { key: string; label: string; type: "text" | "password" | "url"; required: boolean; placeholder?: string }[];
  inputValues: Record<string, string>;
  models: (TextModel | ImageModel | VideoModel | TTSModel)[];
}

type ReferenceList =
  | { type: "image"; sourceType: "base64"; base64: string }
  | { type: "audio"; sourceType: "base64"; base64: string }
  | { type: "video"; sourceType: "base64"; base64: string };

interface ImageConfig {
  prompt: string;
  referenceList?: Extract<ReferenceList, { type: "image" }>[];
  size: "1K" | "2K" | "4K";
  aspectRatio: `${number}:${number}`;
}

interface VideoConfig {
  duration: number;
  resolution: string;
  aspectRatio: "16:9" | "9:16";
  prompt: string;
  referenceList?: ReferenceList[];
  audio?: boolean;
  mode: VideoMode[];
}

interface TTSConfig {
  text: string;
  voice: string;
  speechRate: number;
  pitchRate: number;
  volume: number;
  referenceList?: Extract<ReferenceList, { type: "audio" }>[];
}

interface PollResult {
  completed: boolean;
  data?: string;
  error?: string;
}

// ============================================================
// 全局声明
// ============================================================

declare const axios: any;
declare const logger: (msg: string) => void;
declare const jsonwebtoken: any;
declare const zipImage: (base64: string, size: number) => Promise<string>;
declare const zipImageResolution: (base64: string, w: number, h: number) => Promise<string>;
declare const mergeImages: (base64Arr: string[], maxSize?: string) => Promise<string>;
declare const urlToBase64: (url: string) => Promise<string>;
declare const pollTask: (fn: () => Promise<PollResult>, interval?: number, timeout?: number) => Promise<PollResult>;
declare const createOpenAI: any;
declare const createDeepSeek: any;
declare const createZhipu: any;
declare const createQwen: any;
declare const createAnthropic: any;
declare const createOpenAICompatible: any;
declare const createXai: any;
declare const createMinimax: any;
declare const createGoogleGenerativeAI: any;
declare const exports: {
  vendor: VendorConfig;
  textRequest: (m: TextModel, t: boolean, tl: 0 | 1 | 2 | 3) => any;
  imageRequest: (c: ImageConfig, m: ImageModel) => Promise<string>;
  videoRequest: (c: VideoConfig, m: VideoModel) => Promise<string>;
  ttsRequest: (c: TTSConfig, m: TTSModel) => Promise<string>;
  checkForUpdates?: () => Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }>;
  updateVendor?: () => Promise<string>;
};

// ============================================================
// 供应商配置
// ============================================================

const vendor: VendorConfig = {
  id: "newapi",
  version: "1.0",
  author: "custom",
  name: "专用中转站",
  description: "通过中转站调用 GPT-Image 2 等模型",
  inputs: [
    { key: "apiKey", label: "API密钥", type: "password", required: true },
    { key: "baseUrl", label: "请求地址", type: "url", required: true, placeholder: "示例：https://your-newapi.example.com/v1" },
  ],
  inputValues: { apiKey: "", baseUrl: "" },
  models: [
    { name: "GPT-Image 2", modelName: "gpt-image-2", type: "image", mode: ["text", "singleImage", "multiReference"] },
    { name: "GPT-5.5", modelName: "gpt-5.5", type: "text", think: false },
  ],
};

// ============================================================
// 辅助工具
// ============================================================

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function extractFirstImageFromMd(content: string) {
  const regex = /!\[([^\]]*)\]\((data:image\/[^;]+;base64,[A-Za-z0-9+/=]+|https?:\/\/[^\s)]+|\/\/[^\s)]+|[^\s)]+)\)/;
  const match = content.match(regex);
  if (!match) return null;
  const raw = match[2].trim();
  const url = raw.startsWith("data:") ? raw : raw.split(/\s+/)[0];
  return { alt: match[1], url, type: url.startsWith("data:image") ? "base64" : "url" };
}

// ============================================================
// 适配器函数
// ============================================================

const textRequest = (model: TextModel, think: boolean, thinkLevel: 0 | 1 | 2 | 3) => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  return createOpenAI({ baseURL: vendor.inputValues.baseUrl, apiKey }).chat(model.modelName);
};

/** 判断 OpenAI 排队或超时消息（可重试的临时性错误） */
function isRetryableError(text: string): boolean {
  return /processing image|we'll notify you|notify you|lots of people|超时|upstream_error|timeout/i.test(text);
}

const imageRequest = async (config: ImageConfig, model: ImageModel): Promise<string> => {
  if (!vendor.inputValues.apiKey) throw new Error("缺少API Key");
  if (!vendor.inputValues.baseUrl) throw new Error("缺少请求地址");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/+$/, "");

  // gpt-image-2 使用 /images/generations 端点
  if (model.modelName === "gpt-image-2") {
    const body: Record<string, any> = {
      model: model.modelName,
      prompt: config.prompt,
      n: 1,
    };
    if (config.size) body.size = config.size === "1K" ? "1024x1024" : config.size === "2K" ? "1792x1024" : "1024x1792";

    const response = await fetch(`${baseUrl}/images/generations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`图片生成失败: ${response.status}, ${await response.text()}`);
    const data = await response.json();
    const result = data.data?.[0];
    if (!result) throw new Error("图片生成返回为空");
    if (result.b64_json) return `data:image/png;base64,${result.b64_json}`;
    if (result.url) return await urlToBase64(result.url);
    throw new Error("不支持的图片响应格式");
  }

  // GPT-Image 1.5 等旧模型使用 /chat/completions 多模态
  const body: Record<string, any> = {
    model: model.modelName,
    messages: [{ role: "user", content: config.prompt }],
    n: 1,
  };
  const refs = config.referenceList ?? [];
  if (refs.length > 0) {
    body.messages = [
      {
        role: "user",
        content: [
          ...refs.map((r: any) => ({ type: "image_url", image_url: { url: r.base64 } })),
          { type: "text", text: config.prompt },
        ],
      },
    ];
  }

  const MAX_RETRIES = 6;
  const RETRY_DELAY = 30000;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      // 502 → 重试（临时性服务器错误）
      if (response.status === 502) {
        const errText = await response.text();
        logger(`[newapi] 服务暂不可用 (${attempt}/${MAX_RETRIES})，${RETRY_DELAY / 1000}s 后重试`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY); continue; }
        throw new Error(`请求失败: ${response.status}, ${errText}`);
      }

      if (!response.ok) {
        throw new Error(`请求失败: ${response.status}, ${await response.text()}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "";

      // 响应内容也是排队消息 → 重试
      if (isRetryableError(content)) {
        logger(`[newapi] 排队中 (${attempt}/${MAX_RETRIES})，${RETRY_DELAY / 1000}s 后重试`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY); continue; }
        throw new Error("OpenAI 多次排队后仍未生成图片");
      }

      // 尝试提取图片：markdown → b64_json → 纯URL
      const imageResult = extractFirstImageFromMd(content);
      if (imageResult) {
        return imageResult.type === "base64" ? imageResult.url : await urlToBase64(imageResult.url);
      }

      const firstChoice = data.choices?.[0];
      if (firstChoice?.message?.b64_json) {
        return `data:image/png;base64,${firstChoice.message.b64_json}`;
      }

      if (content && /^https?:\/\//.test(content.trim())) {
        return await urlToBase64(content.trim());
      }

      throw new Error("未能从响应中提取图片");
    } catch (e: any) {
      // 非排队相关错误直接抛出
      if (attempt >= MAX_RETRIES || !isRetryableError(e.message || "")) throw e;
      logger(`[newapi] 异常 (${attempt}/${MAX_RETRIES}): ${e.message}，${RETRY_DELAY / 1000}s 后重试`);
      await sleep(RETRY_DELAY);
    }
  }

  throw new Error("所有重试均已耗尽");
};

const videoRequest = async (config: VideoConfig, model: VideoModel): Promise<string> => {
  return "";
};

const ttsRequest = async (config: TTSConfig, model: TTSModel): Promise<string> => {
  return "";
};

const checkForUpdates = async (): Promise<{ hasUpdate: boolean; latestVersion: string; notice: string }> => {
  return { hasUpdate: false, latestVersion: "1.0", notice: "" };
};

const updateVendor = async (): Promise<string> => {
  return "";
};

// ============================================================
// 导出
// ============================================================

exports.vendor = vendor;
exports.textRequest = textRequest;
exports.imageRequest = imageRequest;
exports.videoRequest = videoRequest;
exports.ttsRequest = ttsRequest;
exports.checkForUpdates = checkForUpdates;
exports.updateVendor = updateVendor;

export {};
