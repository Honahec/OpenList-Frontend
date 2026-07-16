import { Upload, SetUpload } from "./types"
import { r, pathDir } from "~/utils"
import { password } from "~/store"

type DirectUploadInfo = {
  upload_url?: string
  chunk_size?: number
  headers?: Record<string, string>
  method?: string
  finalize?: boolean
  multipart?: {
    upload_id: string
  }
}

type DirectUploadPartInfo = {
  upload_url: string
  headers?: Record<string, string>
  method?: string
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

  // Get direct upload info from backend
  const resp: any = collection
    ? await r.post(
        `/public/collection/${collection.id}/get_direct_upload_info`,
        {
          password: password(),
          file_name: collection.fileName,
          file_size: file.size,
        },
      )
    : await r.post(
        "/fs/get_direct_upload_info",
        {
          path,
          file_name: file.name,
          file_size: file.size,
          tool: "HttpDirect",
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

  let uploadInfo: DirectUploadInfo
  const context: UploadContext = { path, fileName: file.name }
  if (collection) {
    const data = resp.data as {
      file_name: string
      upload_token: string
      upload_session: string
      upload_info: DirectUploadInfo
    }
    uploadInfo = data.upload_info
    context.fileName = data.file_name
    context.collection = {
      id: collection.id,
      token: data.upload_token,
      session: data.upload_session,
    }
  } else {
    uploadInfo = resp.data as DirectUploadInfo
  }

  // If upload_info is null, direct upload is not supported - fallback to Stream
  if (!uploadInfo) {
    throw new Error("Http Direct Upload not supported")
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
  setUpload?: SetUpload,
): Promise<undefined> {
  if (chunkSize <= 0 || !uploadID) {
    throw new Error("Invalid multipart direct upload session")
  }

  const totalParts = Math.ceil(file.size / chunkSize)
  const calcSpeed = createSpeedCalculator()
  let uploadedBytes = 0

  try {
    for (let i = 0; i < totalParts; i++) {
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
              part_number: i + 1,
            },
          )
        : await r.post("/fs/get_direct_upload_part_info", {
            path: context.path,
            file_name: context.fileName,
            file_size: file.size,
            upload_id: uploadID,
            part_number: i + 1,
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
    xhr.send(part)
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
