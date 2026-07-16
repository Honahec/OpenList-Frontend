import {
  Badge,
  Box,
  Button,
  Heading,
  Input,
  Progress,
  ProgressIndicator,
  Text,
  VStack,
} from "@hope-ui/solid"
import { For, Show, createSignal } from "solid-js"
import { useRouter, useT } from "~/hooks"
import { getFileSize, r } from "~/utils"

type UploadInfo = {
  upload_url?: string
  chunk_size?: number
  headers?: Record<string, string>
  method?: string
  multipart?: { upload_id: string }
}

type UploadItem = {
  file: File
  progress: number
  status: "pending" | "uploading" | "success" | "error"
  message?: string
}

const request = async <T,>(promise: Promise<any>): Promise<T> => {
  const resp = await promise
  if (resp.code !== 200) throw new Error(resp.message || "Request failed")
  return resp.data as T
}

const put = async (
  body: Blob,
  url: string,
  method: string,
  headers: Record<string, string> | undefined,
  onProgress: (loaded: number) => void,
) =>
  new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open(method || "PUT", url)
    Object.entries(headers || {}).forEach(([key, value]) =>
      xhr.setRequestHeader(key, value),
    )
    xhr.upload.onprogress = (event) => onProgress(event.loaded)
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status})`))
    xhr.onerror = () => reject(new Error("Upload failed"))
    xhr.send(body)
  })

export default function Collection() {
  const t = useT()
  const { params } = useRouter()
  const id = () => params.id
  const [password, setPassword] = createSignal("")
  const [info, setInfo] = createSignal<any>()
  const [error, setError] = createSignal("")
  const [items, setItems] = createSignal<UploadItem[]>([])
  const [uploading, setUploading] = createSignal(false)

  const load = async () => {
    setError("")
    try {
      setInfo(
        await request(
          r.get(`/public/collection/${id()}/info`, {
            params: { password: password() },
          }),
        ),
      )
    } catch (e: any) {
      setError(e.message)
    }
  }

  const update = (file: File, patch: Partial<UploadItem>) =>
    setItems((all) =>
      all.map((item) => (item.file === file ? { ...item, ...patch } : item)),
    )

  const upload = async (file: File) => {
    update(file, { status: "uploading", progress: 0, message: "" })
    let storedName = ""
    let uploadID = ""
    let uploadToken = ""
    let uploadSession = ""
    try {
      const created = await request<{
        file_name: string
        upload_token: string
        upload_session: string
        upload_info: UploadInfo
      }>(
        r.post(`/public/collection/${id()}/get_direct_upload_info`, {
          password: password(),
          file_name: file.name,
          file_size: file.size,
        }),
      )
      storedName = created.file_name
      uploadToken = created.upload_token
      uploadSession = created.upload_session
      const direct = created.upload_info
      uploadID = direct.multipart?.upload_id || ""
      if (uploadID) {
        const chunkSize = direct.chunk_size || 0
        const parts = Math.ceil(file.size / chunkSize)
        let completed = 0
        for (let part = 1; part <= parts; part++) {
          const start = (part - 1) * chunkSize
          const blob = file.slice(start, Math.min(start + chunkSize, file.size))
          const partInfo = await request<UploadInfo>(
            r.post(`/public/collection/${id()}/get_direct_upload_part_info`, {
              password: password(),
              file_name: storedName,
              file_size: file.size,
              upload_id: uploadID,
              upload_token: uploadToken,
              upload_session: uploadSession,
              part_number: part,
            }),
          )
          await put(
            blob,
            partInfo.upload_url!,
            partInfo.method || "PUT",
            partInfo.headers,
            (loaded) =>
              update(file, {
                progress: ((completed + loaded) / file.size) * 100,
              }),
          )
          completed += blob.size
        }
      } else {
        await put(
          file,
          direct.upload_url!,
          direct.method || "PUT",
          direct.headers,
          (loaded) => update(file, { progress: (loaded / file.size) * 100 }),
        )
      }
      await request(
        r.post(`/public/collection/${id()}/complete_direct_upload`, {
          password: password(),
          file_name: storedName,
          file_size: file.size,
          upload_id: uploadID,
          upload_token: uploadToken,
          upload_session: uploadSession,
        }),
      )
      update(file, { status: "success", progress: 100 })
    } catch (e: any) {
      if (uploadID && storedName && uploadToken) {
        await r.post(`/public/collection/${id()}/abort_direct_upload`, {
          password: password(),
          file_name: storedName,
          file_size: file.size,
          upload_id: uploadID,
          upload_token: uploadToken,
          upload_session: uploadSession,
        })
      }
      update(file, { status: "error", message: e.message })
    }
  }

  const start = async () => {
    setUploading(true)
    for (const item of items()) await upload(item.file)
    setUploading(false)
  }

  return (
    <Box maxW="$xl" mx="auto" p="$6">
      <VStack spacing="$4" alignItems="stretch">
        <Heading>{t("shares.collection.title")}</Heading>
        <Show when={!info()}>
          <Text>{t("shares.collection.password_tip")}</Text>
          <Input
            type="password"
            value={password()}
            onInput={(e) => setPassword(e.currentTarget.value)}
          />
          <Button colorScheme="accent" onClick={load}>
            {t("shares.collection.open")}
          </Button>
          <Text color="$danger10">{error()}</Text>
        </Show>
        <Show when={info()}>
          <Text>{info()?.remark || t("shares.collection.description")}</Text>
          <Show when={info()?.remaining >= 0}>
            <Text>
              {t("shares.collection.remaining", {
                count: info()?.remaining,
              })}
            </Text>
          </Show>
          <Input
            type="file"
            multiple
            onChange={(e) => {
              const files = Array.from(e.currentTarget.files || [])
              setItems(
                files.map((file) => ({ file, progress: 0, status: "pending" })),
              )
            }}
          />
          <For each={items()}>
            {(item) => (
              <VStack alignItems="stretch" spacing="$1">
                <Text>
                  {item.file.name} · {getFileSize(item.file.size)}
                </Text>
                <Progress value={item.progress}>
                  <ProgressIndicator />
                </Progress>
                <Badge>{t(`shares.collection.status.${item.status}`)}</Badge>
                <Text color="$danger10">{item.message}</Text>
              </VStack>
            )}
          </For>
          <Button
            colorScheme="accent"
            disabled={!items().length || uploading()}
            loading={uploading()}
            onClick={start}
          >
            {t("shares.collection.start")}
          </Button>
        </Show>
      </VStack>
    </Box>
  )
}
