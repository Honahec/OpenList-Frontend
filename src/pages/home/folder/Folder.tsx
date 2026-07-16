import {
  lazy,
  createEffect,
  createMemo,
  onCleanup,
  Switch,
  Match,
  Show,
  on,
  For,
  createSignal,
} from "solid-js"
import {
  Button,
  FormControl,
  FormLabel,
  Input,
  Text,
  VStack,
} from "@hope-ui/solid"
import { layout, local, objStore, password } from "~/store"
import { ContextMenu } from "./context-menu"
import { Pager } from "./Pager"
import { useLink, usePath, useRouter, useT } from "~/hooks"
import { ObjType } from "~/types"
import { bus, handleResp, notify, r } from "~/utils"
import lightGallery from "lightgallery"
import lgThumbnail from "lightgallery/plugins/thumbnail"
import lgZoom from "lightgallery/plugins/zoom"
import lgRotate from "lightgallery/plugins/rotate"
import lgAutoplay from "lightgallery/plugins/autoplay"
import lgFullscreen from "lightgallery/plugins/fullscreen"
import "lightgallery/css/lightgallery-bundle.css"
import { LightGallery } from "lightgallery/lightgallery"
import { Search } from "./Search"

const ListLayout = lazy(() => import("./List"))
const GridLayout = lazy(() => import("./Grid"))
const ImageLayout = lazy(() => import("./Images"))

const Folder = () => {
  const t = useT()
  const { rawLink } = useLink()
  const { isCollection, pathname } = useRouter()
  const { refresh } = usePath()
  const [submissionValues, setSubmissionValues] = createSignal<
    Record<string, string>
  >({})
  const [savingSubmission, setSavingSubmission] = createSignal(false)
  const collectionRoot = createMemo(() => /^\/@c\/[^/]+\/?$/.test(pathname()))
  const collectionID = createMemo(() => pathname().split("/")[2] ?? "")
  const collectionForm = createMemo(() => objStore.collection_form)
  createEffect(() => {
    const form = collectionForm()
    setSubmissionValues(form ? { ...form.values } : {})
  })
  const submissionValid = createMemo(() =>
    (collectionForm()?.fields ?? []).every(
      (field) => !field.required || !!submissionValues()[field.name]?.trim(),
    ),
  )
  const saveSubmission = async () => {
    setSavingSubmission(true)
    try {
      const resp: any = await r.post(
        `/public/collection/${encodeURIComponent(collectionID())}/submission`,
        {
          password: password(),
          values: submissionValues(),
        },
      )
      handleResp(resp, async () => {
        notify.success(t("global.save_success"))
        await refresh()
      })
    } finally {
      setSavingSubmission(false)
    }
  }
  const images = createMemo(() =>
    objStore.objs.filter((obj) => obj.type === ObjType.IMAGE),
  )

  let dynamicGallery: LightGallery | undefined
  const initGallery = () => {
    dynamicGallery = lightGallery(document.createElement("div"), {
      addClass: "lightgallery-container",
      dynamic: true,
      thumbnail: local["show_gallery_thumbnails"] === "visible",
      plugins: [lgZoom, lgThumbnail, lgRotate, lgAutoplay, lgFullscreen],
      dynamicEl: images().map((obj) => {
        const raw = rawLink(obj, true)
        return {
          src: raw,
          thumb: obj.thumb === "" ? raw : obj.thumb,
          subHtml: `<h4>${obj.name}</h4>`,
        }
      }),
    })
  }
  createEffect(
    on([images, () => local["show_gallery_thumbnails"]], () => {
      dynamicGallery?.destroy()
      dynamicGallery = undefined
    }),
  )
  bus.on("gallery", (name) => {
    if (!dynamicGallery) {
      initGallery()
    }
    dynamicGallery?.openGallery(images().findIndex((obj) => obj.name === name))
  })
  onCleanup(() => {
    bus.off("gallery")
    dynamicGallery?.destroy()
  })
  return (
    <>
      <Show when={isCollection() && collectionRoot() && collectionForm()}>
        <VStack w="$full" alignItems="stretch" spacing="$2" p="$2">
          <Text fontWeight="bold">
            {t("shares.collection.submission.title")}
          </Text>
          <Text color="$neutral11">
            {t("shares.collection.submission.description")}
          </Text>
          <For each={collectionForm()!.fields}>
            {(field, index) => (
              <FormControl required={field.required}>
                <FormLabel for={`collection-field-${index()}`}>
                  {field.required
                    ? field.name
                    : `${field.name} (${t("shares.collection.submission.optional")})`}
                </FormLabel>
                <Input
                  id={`collection-field-${index()}`}
                  value={submissionValues()[field.name] ?? ""}
                  onInput={(event) =>
                    setSubmissionValues({
                      ...submissionValues(),
                      [field.name]: event.currentTarget.value,
                    })
                  }
                />
              </FormControl>
            )}
          </For>
          <Button
            alignSelf="start"
            loading={savingSubmission()}
            disabled={!submissionValid()}
            onClick={saveSubmission}
          >
            {t("global.save")}
          </Button>
        </VStack>
      </Show>
      <Switch>
        <Match when={layout() === "list"}>
          <ListLayout />
        </Match>
        <Match when={layout() === "grid"}>
          <GridLayout />
        </Match>
        <Match when={layout() === "image"}>
          <ImageLayout images={images()} />
        </Match>
      </Switch>
      <Pager />
      <Show when={!isCollection()}>
        <Search />
        <ContextMenu />
      </Show>
    </>
  )
}

export default Folder
