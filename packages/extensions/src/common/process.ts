/**
 * 将流内容读取为字符串并限制最大字节数。
 *
 * @param stream 可读流
 * @param maxBytes 最大字节数
 * @returns 文本与截断标识
 */
export const readStreamWithLimit = async (
  stream: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> => {
  if (!stream) {
    return { text: "", truncated: false };
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    const room = maxBytes - total;
    if (room <= 0) {
      truncated = true;
      break;
    }
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total += room;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(merged), truncated };
};

/**
 * 尝试优雅结束子进程，必要时强制杀死。
 *
 * @param pid 进程 PID
 * @param graceMs SIGTERM 后等待时长
 */
export const terminateProcess = async (pid: number, graceMs = 3000): Promise<void> => {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  await new Promise<void>((resolve) => setTimeout(resolve, graceMs));
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 进程已结束
  }
};
