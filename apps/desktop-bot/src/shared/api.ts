// Types shared by the main process, the preload bridge and the renderer. Types only: no code.

export interface BotSettings {
  botName: string;
  /** Absolute path of the chosen bot image inside the app's data folder, or null for the built-in cat. */
  imagePath: string | null;
  quiet: boolean;
}

export interface ViewSettings extends BotSettings {
  /** file:// URL the renderer can show, or null for the built-in cat. */
  imageUrl: string | null;
  /** True when a model key is set, so chat gives real answers. */
  hasModelKey: boolean;
}

export interface ImageResult {
  id: string;
  title: string;
  /** Small picture (served by Openverse). This is what becomes the bot. */
  thumbnail: string;
  license: string;
  licenseUrl: string | null;
  creator: string | null;
  pageUrl: string | null;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ChatReply {
  text: string;
  /** True when no model key is set and this is a built-in demo reply. */
  demo: boolean;
}

export interface BotApi {
  getSettings(): Promise<ViewSettings>;
  pickImage(): Promise<Result<ViewSettings>>;
  searchImages(query: string): Promise<Result<ImageResult[]>>;
  useSearchImage(image: ImageResult): Promise<Result<ViewSettings>>;
  saveProcessedImage(pngDataUrl: string): Promise<Result<ViewSettings>>;
  resetImage(): Promise<Result<ViewSettings>>;
  setQuiet(quiet: boolean): Promise<Result<ViewSettings>>;
  chat(message: string): Promise<Result<ChatReply>>;
  /** Tell the window whether the mouse is over something clickable (otherwise clicks pass through). */
  setInteractive(interactive: boolean): void;
  quit(): void;
}
