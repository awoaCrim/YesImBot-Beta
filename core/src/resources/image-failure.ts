/** Internal failure codes attached to inbound images that could not be persisted or opened. */
export type ImageFailureCode =
  | "missing_source"
  | "image_limit"
  | "total_size_limit"
  | "timeout"
  | "too_large"
  | "not_image"
  | "download_failed"
  | "save_failed"
  | "resource_missing"
  | "resource_unavailable"
  | "resource_aborted";

const IMAGE_FAILURE_LABELS: Readonly<Record<ImageFailureCode, string>> = {
  missing_source: "缺少来源",
  image_limit: "数量超限",
  total_size_limit: "总大小超限",
  timeout: "读取超时",
  too_large: "文件过大",
  not_image: "不是有效图片",
  download_failed: "下载失败",
  save_failed: "保存失败",
  resource_missing: "资源不存在",
  resource_unavailable: "资源不可用",
  resource_aborted: "读取已取消",
};

export function isImageFailureCode(value: unknown): value is ImageFailureCode {
  return typeof value === "string" && value in IMAGE_FAILURE_LABELS;
}

/** Returns a bounded, user/model-visible reason without exposing raw URLs or exceptions. */
export function imageFailureLabel(value: unknown): string {
  return isImageFailureCode(value) ? IMAGE_FAILURE_LABELS[value] : "资源不可用";
}

export function formatImageFailure(value: unknown): string {
  return `[图片：${imageFailureLabel(value)}]`;
}
