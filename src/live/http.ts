/** Tiny JSON helper with a hard timeout and real error messages. */

export async function postJson(url: string, body: unknown, timeoutMs = 45000): Promise<any> {
  const ac = new AbortController();
  const timer = window.setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }

    if (!res.ok) {
      throw new Error(data?.error || `${url} failed (${res.status})`);
    }
    return data ?? {};
  } catch (err: any) {
    if (err?.name === "AbortError") throw new Error(`${url} timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw err;
  } finally {
    window.clearTimeout(timer);
  }
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string | null;
      const base64 = result?.split(",")[1];
      if (base64) resolve(base64);
      else reject(new Error("Could not encode audio chunk."));
    };
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed."));
    reader.readAsDataURL(blob);
  });
}
