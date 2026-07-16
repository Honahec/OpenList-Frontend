import { objStore } from "~/store"
import { FormUpload } from "./form"
import { StreamUpload } from "./stream"
import { HttpDirectUpload } from "./direct"
import { Upload } from "./types"
import { trimBase } from "~/utils"

const isCollection = () =>
  trimBase(decodeURIComponent(location.pathname)).startsWith("/@c/")

type Uploader = {
  upload: Upload
  name: string
  available: () => boolean
}

// All upload methods
const AllUploads: Uploader[] = [
  {
    name: "HTTP Direct",
    upload: HttpDirectUpload,
    available: () => {
      return objStore.direct_upload_tools?.includes("HttpDirect") || false
    },
  },
  {
    name: "Stream",
    upload: StreamUpload,
    available: () => !isCollection(),
  },
  {
    name: "Form",
    upload: FormUpload,
    available: () => !isCollection(),
  },
]

export const getUploads = (): Pick<Uploader, "name" | "upload">[] => {
  return AllUploads.filter((u) => u.available())
}
