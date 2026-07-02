// 管线阶段
export type PipelineStage = "director_analysis" | "art_design" | "seedance_prompts" | "miwo";

// 阶段状态
export type StageStatus = "pending" | "generating" | "review" | "passed" | "failed";

// 集数状态
export type EpisodeStatus = "pending" | "directing" | "designing" | "storyboarding" | "done";

// 视觉风格预设
export const VISUAL_STYLES = [
  "真人写实",
  "3D CG",
  "皮克斯",
  "迪士尼",
  "国漫",
  "日漫",
  "韩漫",
  "自定义",
] as const;

export type VisualStyle = (typeof VISUAL_STYLES)[number];

// 目标媒介
export const TARGET_MEDIUMS = ["电影", "短剧", "漫剧", "MV", "广告"] as const;

export type TargetMedium = (typeof TARGET_MEDIUMS)[number];

// Seedance 项目配置
export interface SeedanceProject {
  id: number;
  projectId: number;
  visualStyle: string;
  targetMedium: string;
  directorVersion: string; // "pro" | "ultra"
  createdAt: number;
}

// 集数
export interface SeedanceEpisode {
  id: number;
  projectId: number;
  episodeKey: string;
  scriptContent: string;
  status: EpisodeStatus;
  createdAt: number;
}

// 管线产出
export interface SeedanceOutput {
  id: number;
  episodeId: number;
  stage: PipelineStage;
  stageStatus: StageStatus;
  content: string | null;
  assetIds: string | null;
  reviewFeedback: string | null;
  messages: string | null;
  createdAt: number;
  updatedAt: number;
}

// 导演分析产出
export interface DirectorAnalysis {
  plotPoints: PlotPoint[];
  characterList: CharacterItem[];
  sceneList: SceneItem[];
}

export interface PlotPoint {
  id: string;
  duration: number;
  directorNotes: string;
  characters: string[];
  characterIds?: number[];
  scene: string;
  sceneId?: number;
}

export interface CharacterItem {
  name: string;
  assetId?: number;
  age: string;
  appearance: string;
  assetStatus: "new" | "reuse" | "variant";
}

export interface SceneItem {
  name: string;
  assetId?: number;
  time: string;
  lighting: string;
  atmosphere: string;
  assetStatus: "new" | "reuse" | "variant";
}

// 服化道设计产出
export interface ArtDesignOutput {
  characterPrompts: CharacterPrompt[];
  scenePrompts: ScenePrompt[];
}

export interface CharacterPrompt {
  name: string;
  prompt: string;
  assetId?: number;
  imageState?: string;
}

export interface ScenePrompt {
  name: string;
  prompt: string;
  assetId?: number;
  imageState?: string;
}

// 分镜视频产出
export interface SeedancePromptOutput {
  assetMapping: AssetMapping[];
  videoClips: VideoClip[];
}

export interface AssetMapping {
  refId: string;
  assetId: number;
  name: string;
  description: string;
}

export interface VideoClip {
  plotId: string;
  duration: number;
  prompt: string;
  videoAssetId?: number;
  videoState?: string;
}

// API 请求/响应类型
export interface InitProjectRequest {
  projectId: number;
  visualStyle: string;
  targetMedium: string;
}

export interface ImportScriptRequest {
  projectId: number;
  scriptContent: string;
}

export interface RunStageRequest {
  episodeId: number;
  stage: PipelineStage;
}

export interface SubmitReviewRequest {
  episodeId: number;
  stage: PipelineStage;
  feedback: string;
}

export interface RegenerateAssetRequest {
  episodeId: number;
  assetType: "character" | "scene";
  assetIndex: number;
}

