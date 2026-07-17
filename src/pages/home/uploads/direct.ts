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
  let uploadedBytes = 0
  for (let partNumber = 1; partNumber <= totalParts; partNumber++) {
    if (!required.has(partNumber)) {
      const start = (partNumber - 1) * chunkSize
      uploadedBytes += Math.min(chunkSize, file.size - start)
    }
  }
  setUpload?.("progress", (uploadedBytes / file.size) * 100)

  try {
    for (const partNumber of parts) {
      const i = partNumber - 1
      if (i < 0 || i >= totalParts) {
        throw new Error(`Invalid direct upload part ${partNumber}`)
      }
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, file.size)
      const part = file.slice(start, end)
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
        throw new Error(`Upload URL for part ${i + 1} is missing`)
      }
      await uploadPart(
        part,
        partInfo.upload_url,
        partInfo.method || "PUT",
        partInfo.headers,
        partInfo.body_mode,
        context.fileName,
        uploadedBytes,
        file.size,
        calcSpeed,
        setUpload,
      )
      uploadedBytes += part.size
    }

    await completeDirectUpload(context, file, uploadID)
    return undefined
  } catch (error) {
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
  uploadedBytes: number,
  totalBytes: number,
  calcSpeed: ReturnType<typeof createSpeedCalculator>,
  setUpload?: SetUpload,
): Promise<void> {
  const xhr = new XMLHttpRequest()
  await new Promise<void>((resolve, reject) => {
    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && setUpload) {
        const totalLoaded = uploadedBytes + e.loaded
        setUpload("progress", (totalLoaded / totalBytes) * 100)
        calcSpeed(totalLoaded, setUpload)
      }
    })
    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
      } else {
        reject(new Error(`Upload part failed with status ${xhr.status}`))
      }
    })
    xhr.addEventListener("error", () => reject(new Error("Upload part failed")))
    xhr.open(method, uploadURL)
    if (headers) {
      Object.entries(headers).forEach(([key, value]) => {
        xhr.setRequestHeader(key, value)
      })
    }
    if (bodyMode === "multipart") {
      const form = new FormData()
      form.append("file", part, fileName)
      xhr.send(form)
    } else {
      xhr.send(part)
    }
  })
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
        reject(new Error(`Upload failed with status ${xhr.status}`))
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
