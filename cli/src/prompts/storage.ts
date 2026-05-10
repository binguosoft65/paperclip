import * as p from "@clack/prompts";
import type { StorageConfig } from "../config/schema.js";
import { resolveDefaultStorageDir, resolvePaperclipInstanceId } from "../config/home.js";

function defaultStorageBaseDir(): string {
  return resolveDefaultStorageDir(resolvePaperclipInstanceId());
}

export function defaultStorageConfig(): StorageConfig {
  return {
    provider: "local_disk",
    localDisk: {
      baseDir: defaultStorageBaseDir(),
    },
    s3: {
      bucket: "paperclip",
      region: "us-east-1",
      endpoint: undefined,
      prefix: "",
      forcePathStyle: false,
    },
  };
}

// 存储配置交互提示
// 两个选项：
// - local_disk（推荐）：存储在实例根目录下的 data/storage 目录
// - s3：需要配置 bucket/region/endpoint，支持 S3 兼容存储
// 选择 local_disk 时隐藏 S3 字段，反之亦然，降低用户认知负担
export async function promptStorage(current?: StorageConfig): Promise<StorageConfig> {
  const base = current ?? defaultStorageConfig();

  const provider = await p.select({
    message: "Storage provider",
    options: [
      {
        value: "local_disk" as const,
        label: "Local disk (recommended)",
        hint: "best for single-user local deployments",
      },
      {
        value: "s3" as const,
        label: "S3 compatible",
        hint: "for cloud/object storage backends",
      },
    ],
    initialValue: base.provider,
  });

  if (p.isCancel(provider)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  if (provider === "local_disk") {
    const baseDir = await p.text({
      message: "Local storage base directory",
      defaultValue: base.localDisk.baseDir || defaultStorageBaseDir(),
      placeholder: defaultStorageBaseDir(),
      validate: (value) => {
        if (!value || value.trim().length === 0) return "Storage base directory is required";
      },
    });

    if (p.isCancel(baseDir)) {
      p.cancel("Setup cancelled.");
      process.exit(0);
    }

    return {
      provider: "local_disk",
      localDisk: {
        baseDir: baseDir.trim(),
      },
      s3: base.s3,
    };
  }

  const bucket = await p.text({
    message: "S3 bucket",
    defaultValue: base.s3.bucket || "paperclip",
    placeholder: "paperclip",
    validate: (value) => {
      if (!value || value.trim().length === 0) return "Bucket is required";
    },
  });

  if (p.isCancel(bucket)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const region = await p.text({
    message: "S3 region",
    defaultValue: base.s3.region || "us-east-1",
    placeholder: "us-east-1",
    validate: (value) => {
      if (!value || value.trim().length === 0) return "Region is required";
    },
  });

  if (p.isCancel(region)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const endpoint = await p.text({
    message: "S3 endpoint (optional for compatible backends)",
    defaultValue: base.s3.endpoint ?? "",
    placeholder: "https://s3.amazonaws.com",
  });

  if (p.isCancel(endpoint)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const prefix = await p.text({
    message: "Object key prefix (optional)",
    defaultValue: base.s3.prefix ?? "",
    placeholder: "paperclip/",
  });

  if (p.isCancel(prefix)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  const forcePathStyle = await p.confirm({
    message: "Use S3 path-style URLs?",
    initialValue: base.s3.forcePathStyle ?? false,
  });

  if (p.isCancel(forcePathStyle)) {
    p.cancel("Setup cancelled.");
    process.exit(0);
  }

  return {
    provider: "s3",
    localDisk: base.localDisk,
    s3: {
      bucket: bucket.trim(),
      region: region.trim(),
      endpoint: endpoint.trim() || undefined,
      prefix: prefix.trim(),
      forcePathStyle,
    },
  };
}

