/**
 * Eksport tablicy „Karteczki”: wykonanie planu rysowania z core (`canvasExportScene`) na `<canvas>` 2D
 * i zapis PNG albo PDF (core `pdfDocument` z obrazami JPEG stron, `canvasPdfPages`). Bez DOM tablicy
 * i bez sieci — działa offline i na liście tylko do podglądu.
 */
import {
  canvasExportScene,
  canvasPdfPages,
  canvasRasterScale,
  pdfDocument,
  PDF_MIME,
  type CanvasDrawOp,
  type CanvasExportInput,
  type CanvasExportOptions,
  type CanvasFontWeight,
  type CanvasMeasure,
  type CanvasPdfOptions,
  type CanvasScene,
  type PdfPage,
} from "@taskplanner/core";

/** Ta sama czcionka co karta na ekranie (`canvas.tsx` `titleFit`). */
const fontFamily = () => getComputedStyle(document.body).fontFamily;
const font = (size: number, weight: CanvasFontWeight, family: string) => `${weight} ${size}px ${family}`;

let measureContext: CanvasRenderingContext2D | null = null;

/** Szerokość tekstu w px (`measureText`), z zapasem na brak kontekstu 2D. */
export function canvasMeasure(): CanvasMeasure {
  const family = fontFamily();
  measureContext ??= document.createElement("canvas").getContext("2d");
  return (text, size, weight) => {
    if (!measureContext) return text.length * size * 0.55;
    measureContext.font = font(size, weight, family);
    return measureContext.measureText(text).width;
  };
}

const SHADOW = {
  card: { color: "rgb(0 0 0 / 0.18)", blur: 5, y: 2 },
  fold: { color: "rgb(0 0 0 / 0.25)", blur: 2, y: -1 },
} as const;

/** Wykonanie operacji planu; `scale` = piksele płótna na px planu (cień nie skaluje się z transformacją). */
function drawOps(ctx: CanvasRenderingContext2D, ops: readonly CanvasDrawOp[], scale: number, family: string) {
  for (const op of ops) {
    ctx.save();
    ctx.globalAlpha = op.alpha ?? 1;
    if (op.kind === "text") {
      ctx.font = font(op.size, op.weight, family);
      ctx.fillStyle = op.color;
      ctx.textAlign = op.align ?? "left";
      ctx.textBaseline = "middle";
      ctx.fillText(op.text, op.x, op.y);
      ctx.restore();
      continue;
    }
    ctx.beginPath();
    if (op.kind === "rect") {
      if (op.radius && typeof ctx.roundRect === "function") ctx.roundRect(op.x, op.y, op.w, op.h, op.radius);
      else ctx.rect(op.x, op.y, op.w, op.h);
    } else if (op.kind === "circle") ctx.arc(op.x, op.y, op.r, 0, Math.PI * 2);
    else {
      op.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (op.kind === "polygon") ctx.closePath();
    }
    if (op.kind !== "line" && op.fill) {
      if (op.shadow) {
        const s = SHADOW[op.shadow];
        ctx.shadowColor = s.color;
        ctx.shadowBlur = s.blur * scale;
        ctx.shadowOffsetY = s.y * scale;
      }
      ctx.fillStyle = op.fill;
      ctx.fill();
      ctx.shadowColor = "transparent";
    }
    if (op.stroke) {
      ctx.strokeStyle = op.stroke;
      ctx.lineWidth = op.lineWidth ?? 1;
      ctx.setLineDash(op.dash ? [...op.dash] : []);
      ctx.lineJoin = "miter";
      ctx.stroke();
    }
    ctx.restore();
  }
}

/** Wycinek planu (`crop`, px planu) na nowym płótnie w skali `scale`. */
function renderCrop(scene: CanvasScene, crop: { x: number; y: number; w: number; h: number }, scale: number, family: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(crop.w * scale));
  canvas.height = Math.max(1, Math.round(crop.h * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Przeglądarka nie dała płótna do rysowania — tablica może być za duża.");
  ctx.fillStyle = scene.background;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(canvas.width / crop.w, 0, 0, canvas.height / crop.h, -crop.x * (canvas.width / crop.w), -crop.y * (canvas.height / crop.h));
  drawOps(ctx, scene.ops, scale, family);
  return canvas;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Nie udało się zapisać obrazu — tablica może być za duża."))), type, quality),
  );
}

/** Plan rysowania po załadowaniu czcionek (inaczej `measureText` liczyłby czcionką zastępczą). */
export async function exportScene(input: CanvasExportInput, options: Omit<CanvasExportOptions, "measure">): Promise<CanvasScene> {
  await document.fonts?.ready;
  return canvasExportScene(input, { ...options, measure: canvasMeasure() });
}

/** PNG całego planu w skali 2× (mniej przy dużej tablicy — limit płótna). */
export async function canvasPng(scene: CanvasScene): Promise<{ blob: Blob; scale: number }> {
  const scale = canvasRasterScale(scene.width, scene.height);
  const canvas = renderCrop(scene, { x: 0, y: 0, w: scene.width, h: scene.height }, scale, fontFamily());
  return { blob: await toBlob(canvas, "image/png"), scale };
}

/** PDF: każda strona rastrowana osobno do JPEG i wstawiona do własnego zapisu PDF. */
export async function canvasPdf(scene: CanvasScene, options: CanvasPdfOptions, title: string): Promise<{ blob: Blob; pages: number }> {
  const family = fontFamily();
  const pages: PdfPage[] = [];
  for (const plan of canvasPdfPages(scene, options)) {
    const canvas = renderCrop(scene, plan.crop, plan.rasterScale, family);
    const jpeg = new Uint8Array(await (await toBlob(canvas, "image/jpeg", 0.92)).arrayBuffer());
    pages.push({
      width: plan.width,
      height: plan.height,
      images: [{ jpeg, pixelWidth: canvas.width, pixelHeight: canvas.height, x: plan.place.x, y: plan.place.y, width: plan.place.w, height: plan.place.h }],
      texts: plan.label ? [plan.label] : [],
    });
  }
  const bytes = pdfDocument(pages, { title });
  return { blob: new Blob([bytes as BlobPart], { type: PDF_MIME }), pages: pages.length };
}
