const VIDEO_FAILURE_LABELS: Readonly<Record<VideoFailureCode, string>> = {
  missing_source: "缺少来源",
  video_limit: "数量超限",
  total_size_limit: "总大小超限",
  timeout: "读取超时",
  too_large: "文件过大",
  not_video: "不是有效视频",
  download_failed: "下载失败",
  save_failed: "保存失败",
  video_input_unavailable: "当前无法查看视频",
  resource_missing: "资源不存在",
  resource_aborted: "读取已取消",
};

const VIDEO_FAILURE_CODES = new Set<string>(Object.keys(VIDEO_FAILURE_LABELS));

/** Internal failure codes attached to inbound videos that could not be persisted or opened. */
export type VideoFailureCode =
  | "missing_source"
  | "video_limit"
  | "total_size_limit"
  | "timeout"
  | "too_large"
  | "not_video"
  | "download_failed"
  | "save_failed"
  | "video_input_unavailable"
  | "resource_missing"
  | "resource_aborted";

export function isVideoFailureCode(value: unknown): value is VideoFailureCode {
  return typeof value === "string" && VIDEO_FAILURE_CODES.has(value);
}

/**
 * Returns a bounded, model-visible reason without exposing raw URLs or exceptions. Unknown codes
 * fall back to the bounded unavailable label instead of surfacing internal text.
 */
export function videoFailureLabel(value: unknown): string {
  return isVideoFailureCode(value) ? VIDEO_FAILURE_LABELS[value] : "资源不可用";
}

export function formatVideoFailure(value: unknown): string {
  return `[视频：${videoFailureLabel(value)}]`;
}
