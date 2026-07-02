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
    { name: "GPT-5.5", modelName: "gpt-5.5", type: "text", think: false },
    { name: "GPT-Image 2", modelName: "gpt-image-2", type: "image", mode: ["text", "singleImage", "multiReference"] },
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
  if (!vendor.inputValues.baseUrl) throw new Error("缺少请求地址");
  const apiKey = vendor.inputValues.apiKey.replace(/^Bearer\s+/i, "");
  const baseUrl = vendor.inputValues.baseUrl.replace(/\/+$/, "");
  return createOpenAICompatible({
    name: model.modelName,
    baseURL: baseUrl,
    apiKey,
  }).chatModel(model.modelName);
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

  const refs = config.referenceList ?? [];
  const isImageToImage = refs.length > 0 && refs[0]?.base64;

  // 构建请求体（按标准 images API 格式，非 chat 格式）
  const sizeMap: Record<string, string> = { "1K": "1024x1024", "2K": "1792x1024", "4K": "2048x2048" };
  const body: Record<string, any> = {
    model: model.modelName,
    prompt: config.prompt,
    n: 1,
    size: sizeMap[config.size] || "1024x1024",
  };

  const endpoint = isImageToImage ? `${baseUrl}/images/edits` : `${baseUrl}/images/generations`;

  // GPT-Image 1.5 / gpt-image-2 负载高时会返回排队消息，自动重试
  const MAX_RETRIES = 6;
  const RETRY_DELAY = 30000; // 30s

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      let fetchBody: BodyInit;
      let contentType: string;

      if (isImageToImage) {
        // /v1/images/edits 用 multipart/form-data
        const form = new FormData();
        form.append("model", model.modelName);
        form.append("prompt", config.prompt);
        const firstRef = refs[0];
        const base64Data = firstRef.base64.replace(/^data:image\/\w+;base64,/, "");
        form.append("image", Buffer.from(base64Data, "base64"), "image.png");
        if (refs.length > 1) {
          const maskData = refs[1].base64.replace(/^data:image\/\w+;base64,/, "");
          form.append("mask", Buffer.from(maskData, "base64"), "mask.png");
        }
        form.append("n", "1");
        fetchBody = form;
        contentType = ""; // fetch 会根据 FormData 自动设置 multipart boundary
      } else {
        // /v1/images/generations 用 JSON
        fetchBody = JSON.stringify(body);
        contentType = "application/json";
      }

      const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
      if (contentType) headers["Content-Type"] = contentType;

      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: fetchBody,
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

      // 标准 images API 响应格式: { data: [{ b64_json, url }] }
      if (data.data?.[0]?.b64_json) {
        return `data:image/png;base64,${data.data[0].b64_json}`;
      }
      if (data.data?.[0]?.url) {
        return await urlToBase64(data.data[0].url);
      }

      // 降级：chat 格式响应适配
      const content = data.choices?.[0]?.message?.content || "";

      // 响应内容也是排队消息 → 重试
      if (isRetryableError(content)) {
        logger(`[newapi] 排队中 (${attempt}/${MAX_RETRIES})，${RETRY_DELAY / 1000}s 后重试`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_DELAY); continue; }
        throw new Error("OpenAI 多次排队后仍未生成图片");
      }

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
