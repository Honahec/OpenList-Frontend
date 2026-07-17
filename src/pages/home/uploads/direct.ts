import { Upload, SetUpload } from "./types"
import { r, pathDir } from "~/utils"
import { password } from "~/store"
import { calculatePartHashes } from "./util"

type DirectUploadInfo = {
  upload_url?: string
  chunk_size?: number
  headers?: Record<string, string>
  method?: string
  finalize?: boolean
  completed?: boolean
  hashing?: {
    algorithm: string
    chunk_size: number
  }
  multipart?: {
    upload_id: string
    parts?: number[]
  }
}

type DirectUploadPartInfo = {
  upload_url: string
  headers?: Record<string, string>
  method?: string
  body_mode?: string
}

type UploadContext = {
  path: string
  fileName: string
  collection?: {
    id: string
    token: string
    session: string
  }
}

const MEBIBYTE = 1024 * 1024
const DIRECT_UPLOAD_TIMEOUT_MS = 180_000
const DIRECT_UPLOAD_MAX_ATTEMPTS = 3
const directUploadSemaphore = new DirectUploadSemaphore(3)

class DirectUploadSemaphore {
  private active = 0
  private readonly queue: Array<{
    resolve: (release: () => void) => void
    reject: (error: DirectUploadPartError) => void
    signal: AbortSignal
    abort: () => void
  }> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      return await task()
    } finally {
      release()
    }
  }

  private acquire(signal: AbortSignal) {
    return new Promise<() => void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new DirectUploadPartError("Upload canceled", 0, true))
        return
      }
      if (this.active < this.limit) {
        this.active++
        resolve(() => this.release())
        return
      }
      const entry = {
        resolve,
        reject,
        signal,
        abort: () => {
          const index = this.queue.indexOf(entry)
          if (index >= 0) this.queue.splice(index, 1)
          reject(new DirectUploadPartError("Upload canceled", 0, true))
        },
      }
      this.queue.push(entry)
      signal.addEventListener("abort", entry.abort, { once: true })
    })
  }

  private release() {
    this.active--
    while (this.queue.length > 0) {
      const entry = this.queue.shift()!
      entry.signal.removeEventListener("abort", entry.abort)
      if (entry.signal.aborted) continue
      this.active++
      entry.resolve(() => this.release())
      return
    }
  }
}

const collectionUpload = (uploadPath: string) => {
  const match = uploadPath.match(/^\/@c\/([^/]+)\/(.+)$/)
  if (!match) return
  return { id: match[1], fileName: match[2] }
}

// Create a speed calculator using closure
function createSpeedCalculator(throttleMs = 500) {
  let lastLoaded = 0
  let lastTime = Date.now()

  return (loaded: number, setUpload?: SetUpload) => {
    const now = Date.now()
    const timeDiff = (now - lastTime) / 1000

    if (timeDiff >= throttleMs / 1000) {
      const speed = (loaded - lastLoaded) / timeDiff
      setUpload?.("speed", speed)
      lastLoaded = loaded
      lastTime = now
    }
  }
}

export const HttpDirectUpload: Upload = async (
  uploadPath: string,
  file: File,
  setUpload: SetUpload,
  _asTask: boolean,
  overwrite: boolean,
  _rapid: boolean,
) => {
  const path = pathDir(uploadPath)
  const collection = collectionUpload(uploadPath)
  const context: UploadContext = { path, fileName: file.name }

  const getUploadInfo = async (partHashes?: string[]) => {
    const resp: any = collection
      ? await r.post(
          `/public/collection/${collection.id}/get_direct_upload_info`,
          {
            password: password(),
            file_name: collection.fileName,
            file_size: file.size,
            part_hashes: partHashes,
          },
        )
      : await r.post(
          "/fs/get_direct_upload_info",
          {
            path,
            file_name: file.name,
            file_size: file.size,
            tool: "HttpDirect",
            part_hashes: partHashes,
          },
          {
            headers: {
              Overwrite: overwrite,
            },
          },
        )

    if (resp.code !== 200) {
      throw new Error(resp.message)
    }

    if (collection) {
      const data = resp.data as {
        file_name: string
        upload_token?: string
        upload_session?: string
        upload_info: DirectUploadInfo
      }
      context.fileName = data.file_name
      if (data.upload_token && data.upload_session) {
        context.collection = {
          id: collection.id,
          token: data.upload_token,
          session: data.upload_session,
        }
      }
      return data.upload_info
    }
    return resp.data as DirectUploadInfo
  }

  let uploadInfo = await getUploadInfo()

  // If upload_info is null, direct upload is not supported - fallback to Stream
  if (!uploadInfo) {
    throw new Error("Http Direct Upload not supported")
  }

  if (uploadInfo.hashing) {
    if (uploadInfo.hashing.algorithm !== "md5") {
      throw new Error(
        `Unsupported direct upload hash: ${uploadInfo.hashing.algorithm}`,
      )
    }
    setUpload("status", "hashing")
    const hashes = await calculatePartHashes(
      file,
      uploadInfo.hashing.chunk_size,
      (progress) => setUpload("progress", progress),
    )
    uploadInfo = await getUploadInfo(hashes)
    if (!uploadInfo || uploadInfo.hashing) {
      throw new Error("Direct upload initialization did not complete")
    }
    setUpload("status", "uploading")
  }

  if (uploadInfo.completed) {
    await completeDirectUpload(context, file)
    return undefined
  }

  // Upload file directly to storage
  const chunkSize = uploadInfo.chunk_size || 0
  const uploadURL = uploadInfo.upload_url
  const method = uploadInfo.method || "PUT"

  if (uploadInfo.multipart) {
    return await uploadMultipart(
      context,
      file,
      chunkSize,
      uploadInfo.multipart.upload_id,
      uploadInfo.multipart.parts,
      setUpload,
    )
  }

  if (!uploadURL) {
    throw new Error("Direct upload URL is missing")
  }

  if (chunkSize > 0) {
    // Always use chunked upload when chunkSize is provided
    // This ensures Content-Range header is set for all files
    await uploadChunked(
      file,
      uploadURL,
      chunkSize,
      method,
      uploadInfo.headers,
      setUpload,
    )
  } else {
    // Single upload for drivers that don't support chunking
    await uploadSingle(file, uploadURL, method, uploadInfo.headers, setUpload)
  }

  if (uploadInfo.finalize) {
    await completeDirectUpload(context, file)
  }

  return undefined
}

async function uploadMultipart(
  context: UploadContext,
  file: File,
  chunkSize: number,
  uploadID: string,
  requiredParts?: number[],
  setUpload?: SetUpload,
): Promise<undefined> {
  if (chunkSize <= 0 || !uploadID) {
    throw new Error("Invalid multipart direct upload session")
  }

  const totalParts = Math.ceil(file.size / chunkSize)
  const parts =
    requiredParts ?? Array.from({ length: totalParts }, (_, i) => i + 1)
  const calcSpeed = createSpeedCalculator()
  const required = new Set(parts)
  let completedBytes = 0
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    if (!required.has(partNumber)) {
      const start = (partNumber - 1) * chunkSize
      completedBytes += Math.min(chunkSize, file.size - start)
    }
  }
  const loadedByPart = new Map<number, number>()
  const sendingParts = new Set<number>()
  const waitingParts = new Set<number>()
  const controller = new AbortController()

  const updateStatus = () => {
    const waitingForStorage = sendingParts.size === 0 && waitingParts.size > 0
    setUpload?.("status", waitingForStorage ? "confirming" : "uploading")
    if (waitingForStorage) setUpload?.("speed", 0)
  }
  const updateProgress = (partNumber: number, loaded: number) => {
    const previous = loadedByPart.get(partNumber) ?? 0
    loadedByPart.set(partNumber, Math.max(previous, loaded))
    const totalLoaded =
      completedBytes +
      Array.from(loadedByPart.values()).reduce((sum, value) => sum + value, 0)
    setUpload?.("progress", (totalLoaded / file.size) * 100)
    calcSpeed(totalLoaded, setUpload)
  }
  setUpload?.("progress", (completedBytes / file.size) * 100)

  const concurrency = getDirectUploadConcurrency(file.size, parts.length)
  let nextPartIndex = 0
  let uploadWorkers: Promise<void>[] = []

  try {
    const uploadNext = async () => {
      while (!controller.signal.aborted) {
        const partIndex = nextPartIndex++
        if (partIndex >= parts.length) return
        const partNumber = parts[partIndex]
        const i = partNumber - 1
        if (i < 0 || i >= totalParts) {
          throw new Error(`Invalid direct upload part ${partNumber}`)
        }
        const start = i * chunkSize
        const end = Math.min(start + chunkSize, file.size)
        const part = file.slice(start, end)
        await uploadPartWithRetry(
          async () => {
            const resp: any = context.collection
              ? await r.post(
                  `/public/collection/${context.collection.id}/get_direct_upload_part_info`,
                  {
                    password: password(),
                    file_name: context.fileName,
                    file_size: file.size,
                    upload_id: uploadID,
                    upload_token: context.collection.token,
                    upload_session: context.collection.session,
                    part_number: partNumber,
                  },
                )
              : await r.post("/fs/get_direct_upload_part_info", {
                  path: context.path,
                  file_name: context.fileName,
                  file_size: file.size,
                  upload_id: uploadID,
                  part_number: partNumber,
                })
            if (resp.code !== 200) throw new Error(resp.message)
            const partInfo = resp.data as DirectUploadPartInfo
            if (!partInfo?.upload_url) {
              throw new Error(`Upload URL for part ${partNumber} is missing`)
            }
            return partInfo
          },
          part,
          context.fileName,
          controller.signal,
          (loaded) => updateProgress(partNumber, loaded),
          () => {
            waitingParts.delete(partNumber)
            sendingParts.add(partNumber)
            updateStatus()
          },
          () => {
            sendingParts.delete(partNumber)
            waitingParts.add(partNumber)
            updateStatus()
          },
        )
        sendingParts.delete(partNumber)
        waitingParts.delete(partNumber)
        updateProgress(partNumber, part.size)
        updateStatus()
      }
    }

    uploadWorkers = Array.from({ length: concurrency }, uploadNext)
    await Promise.all(uploadWorkers)

    setUpload?.("status", "confirming")
    await completeDirectUpload(context, file, uploadID)
    return undefined
  } catch (error) {
    controller.abort()
    await Promise.allSettled(uploadWorkers)
    try {
      if (context.collection) {
        await r.post(
          `/public/collection/${context.collection.id}/abort_direct_upload`,
          {
            password: password(),
            file_name: context.fileName,
            file_size: file.size,
            upload_id: uploadID,
            upload_token: context.collection.token,
            upload_session: context.collection.session,
          },
        )
      } else {
        await r.post("/fs/abort_direct_upload", {
          path: context.path,
          file_name: context.fileName,
          upload_id: uploadID,
        })
      }
    } catch {
      // Preserve the original upload error when cleanup also fails.
    }
    throw error
  }
}

function getDirectUploadConcurrency(fileSize: number, requiredParts: number) {
  if (fileSize <= 64 * MEBIBYTE) return 1
  if (fileSize <= 256 * MEBIBYTE) return Math.min(2, requiredParts)
  return Math.min(3, requiredParts)
}

class DirectUploadPartError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly canceled = false,
  ) {
    super(message)
  }
}

async function uploadPartWithRetry(
  getPartInfo: () => Promise<DirectUploadPartInfo>,
  part: Blob,
  fileName: string,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
  onSending: () => void,
  onWaiting: () => void,
) {
  let lastError: unknown
  for (let attempt = 1; attempt <= DIRECT_UPLOAD_MAX_ATTEMPTS; attempt++) {
    if (signal.aborted) {
      throw new DirectUploadPartError("Upload canceled", 0, true)
    }
    try {
      const partInfo = await getPartInfo()
      await directUploadSemaphore.run(
        () =>
          uploadPart(
            part,
            partInfo.upload_url,
            partInfo.method || "PUT",
            partInfo.headers,
            partInfo.body_mode,
            fileName,
            signal,
            onProgress,
            onSending,
            onWaiting,
          ),
        signal,
      )
      return
    } catch (error) {
      lastError = error
      if (
        attempt === DIRECT_UPLOAD_MAX_ATTEMPTS ||
        !shouldRetryDirectUpload(error)
      ) {
        throw error
      }
      await abortableDelay(1000 * 2 ** (attempt - 1), signal)
    }
  }
  throw lastError
}

function shouldRetryDirectUpload(error: unknown) {
  if (!(error instanceof DirectUploadPartError) || error.canceled) return false
  return (
    error.status === 0 ||
    error.status === 403 ||
    error.status === 408 ||
    error.status === 425 ||
    error.status === 429 ||
    error.status >= 500
  )
}

function abortableDelay(duration: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      window.clearTimeout(timer)
      reject(new DirectUploadPartError("Upload canceled", 0, true))
    }
    const timer = window.setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, duration)
    signal.addEventListener("abort", abort, { once: true })
  })
}

async function completeDirectUpload(
  context: UploadContext,
  file: File,
  uploadID = "",
): Promise<void> {
  const resp: any = context.collection
    ? await r.post(
        `/public/collection/${context.collection.id}/complete_direct_upload`,
        {
          password: password(),
          file_name: context.fileName,
          file_size: file.size,
          upload_id: uploadID,
          upload_token: context.collection.token,
          upload_session: context.collection.session,
        },
      )
    : await r.post("/fs/complete_direct_upload", {
        path: context.path,
        file_name: context.fileName,
        file_size: file.size,
        upload_id: uploadID,
      })
  if (resp.code !== 200) throw new Error(resp.message)
}

async function uploadPart(
  part: Blob,
  uploadURL: string,
  method: string,
  headers: Record<string, string> | undefined,
  bodyMode: string | undefined,
  fileName: string,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
  onSending: () => void,
  onWaiting: () => void,
): Promise<void> {
  if (signal.aborted) {
    throw new DirectUploadPartError("Upload canceled", 0, true)
  }
  const xhr = new XMLHttpRequest()
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort)
    const abort = () => xhr.abort()
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable) onProgress(e.loaded)
    })
    xhr.upload.addEventListener("load", onWaiting)
    xhr.addEventListener("load", () => {
      cleanup()
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(
          new DirectUploadPartError(
            directUploadError(xhr, "Upload part failed"),
            xhr.status,
          ),
        )
      }
    })
    xhr.addEventListener("error", () => {
      cleanup()
      reject(new DirectUploadPartError("Upload part failed"))
    })
    xhr.addEventListener("timeout", () => {
      cleanup()
      reject(
        new DirectUploadPartError(
          `Upload part timed out after ${DIRECT_UPLOAD_TIMEOUT_MS / 1000}s`,
          408,
        ),
      )
    })
    xhr.addEventListener("abort", () => {
      cleanup()
      reject(new DirectUploadPartError("Upload canceled", 0, true))
    })
    xhr.open(method, uploadURL)
    xhr.timeout = DIRECT_UPLOAD_TIMEOUT_MS
    if (headers) {
      Object.entries(headers).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value)
      })
    }
    signal.addEventListener("abort", abort, { once: true })
    if (signal.aborted) {
      abort()
      return
    }
    onSending()
    if (bodyMode === "multipart") {
      const form = new FormData()
      form.append("file", part, fileName)
      xhr.send(form)
    } else {
      xhr.send(part)
    }
  })
}

function directUploadError(xhr: XMLHttpRequest, fallback: string): string {
  const status = xhr.status ? ` with status ${xhr.status}` : ""
  if (!xhr.responseText) return `${fallback}${status}`
  try {
    const body = JSON.parse(xhr.responseText) as {
      error?: string
      upstream_code?: string | number
      upstream_message?: string
      upstream_duration_ms?: number
      cf_colo?: string
      cf_ray?: string
    }
    const details = [
      body.error,
      body.upstream_code === undefined
        ? undefined
        : `code ${body.upstream_code}`,
      body.upstream_message,
      body.upstream_duration_ms === undefined
        ? undefined
        : `upstream ${body.upstream_duration_ms}ms`,
      body.cf_colo ? `colo ${body.cf_colo}` : undefined,
      body.cf_ray ? `ray ${body.cf_ray}` : undefined,
    ].filter(Boolean)
    if (details.length > 0) {
      return `${fallback}${status}: ${details.join("; ")}`
    }
  } catch {
    const text = xhr.responseText.trim().replace(/\s+/g, " ").slice(0, 500)
    if (text) return `${fallback}${status}: ${text}`
  }
  return `${fallback}${status}`
}

async function uploadSingle(
  file: File,
  uploadURL: string,
  method: string,
  headers?: Record<string, string>,
  setUpload?: SetUpload,
): Promise<undefined> {
  const xhr = new XMLHttpRequest()
  const calcSpeed = createSpeedCalculator()

  return new Promise((resolve, reject) => {
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && setUpload) {
        const progress = (e.loaded / e.total) * 100
        setUpload("progress", progress)
        calcSpeed(e.loaded, setUpload)
      }
    })

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(undefined)
      } else {
        reject(new Error(directUploadError(xhr, "Upload failed")))
      }
    })

    xhr.addEventListener("error", () => {
      reject(new Error("Upload failed"))
    })

    xhr.open(method, uploadURL)

    // Set custom headers if provided
    if (headers) {
      Object.entries(headers).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value)
      })
    }

    xhr.send(file)
  })
}

async function uploadChunked(
  file: File,
  uploadURL: string,
  chunkSize: number,
  method: string,
  headers?: Record<string, string>,
  setUpload?: SetUpload,
): Promise<undefined> {
  const totalChunks = Math.ceil(file.size / chunkSize)
  const calcSpeed = createSpeedCalculator()
  let uploadedBytes = 0

  for (let i = 0; i < totalChunks; i++) {
    const start = i * chunkSize
    const end = Math.min(start + chunkSize, file.size)
    const chunk = file.slice(start, end)

    const xhr = new XMLHttpRequest()

    await new Promise<void>((resolve, reject) => {
      xhr.upload.addEventListener("progress", (e) => {
        if (e.lengthComputable && setUpload) {
          const totalLoaded = uploadedBytes + e.loaded
          const progress = (totalLoaded / file.size) * 100
          setUpload("progress", progress)
          calcSpeed(totalLoaded, setUpload)
        }
      })

      xhr.addEventListener("load", () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          uploadedBytes += chunk.size
          resolve()
        } else {
          reject(
            new Error(`Upload chunk ${i + 1} failed with status ${xhr.status}`),
          )
        }
      })

      xhr.addEventListener("error", () => {
        reject(new Error(`Upload chunk ${i + 1} failed`))
      })

      xhr.open(method, uploadURL)

      // Set Content-Range header for chunked upload
      xhr.setRequestHeader(
        "Content-Range",
        `bytes ${start}-${end - 1}/${file.size}`,
      )

      // Set custom headers if provided
      if (headers) {
        Object.entries(headers).forEach(([key, value]) => {
          xhr.setRequestHeader(key, value)
        })
      }

      xhr.send(chunk)
    })
  }

  return undefined
}
