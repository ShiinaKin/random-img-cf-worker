import resize, { initResize } from "@jsquash/resize";

import decodeJpeg, { init as initJpegWasm } from "@jsquash/jpeg/decode";
import decodePng, { init as initPngWasm } from "@jsquash/png/decode";
import decodeWebp, { init as initWebpDecWasm } from "@jsquash/webp/decode";
import encodeWebp, { init as initWebpEncWasm } from "@jsquash/webp/encode";

import JPEG_DEC_WASM from "../node_modules/@jsquash/jpeg/codec/dec/mozjpeg_dec.wasm";
import PNG_DEC_WASM from "../node_modules/@jsquash/png/codec/pkg/squoosh_png_bg.wasm";
import WEBP_DEC_WASM from "../node_modules/@jsquash/webp/codec/dec/webp_dec.wasm";
import WEBP_ENC_WASM from "../node_modules/@jsquash/webp/codec/enc/webp_enc_simd.wasm";
import RESIZE_WASM from "../node_modules/@jsquash/resize/lib/resize/pkg/squoosh_resize_bg.wasm";

const decodeImage = async (buffer, format) => {
  if (format === "jpeg" || format === "jpg") {
    await initJpegWasm(JPEG_DEC_WASM);
    return decodeJpeg(buffer);
  } else if (format === "png") {
    await initPngWasm(PNG_DEC_WASM);
    return decodePng(buffer);
  } else if (format === "webp") {
    await initWebpDecWasm(WEBP_DEC_WASM);
    return decodeWebp(buffer);
  }

  throw new Error(`Unsupported format: ${format}`);
};

async function handleRequest(request, env, ctx) {
  try {
    const url = new URL(request.url);
    const path = url.pathname.split("/").filter((p) => p);
    if (path.length !== 2) {
      return new Response("Invalid URL format. Expected format: uid/pid", {
        status: 400,
      });
    }
    const [uid, pid] = path;
    const imageType = pid.split(".")[1];
    const r2Key = `${uid}/${pid}`;
    let cacheKey;
    const cacheExpire = 60 * 60 * 24 * 7; // 1 week

    // 检查 quality 参数
    const qualityParam = url.searchParams.get("quality");
    let qualityValue = 75; // 默认中等质量
    switch (qualityParam) {
      case "0":
        qualityValue = 100; // 原图
        break;
      case "1":
        qualityValue = 75; // 中等大小图
        break;
      case "2":
        qualityValue = 50; // 缩略图
        break;
    }

    const thParam = url.searchParams.get("th");
    let th;
    if (thParam && !isNaN(parseInt(thParam))) {
      th = parseInt(thParam);
      cacheKey = `image:${uid}:${pid}:${qualityValue}:${th}`;
    } else {
      cacheKey = `image:${uid}:${pid}:${qualityValue}`;
    }

    let webpImage;

    const cacheResult = await env.imagesCache.get(cacheKey, {
      type: "arrayBuffer",
    });

    if (cacheResult) {
      webpImage = cacheResult;
    } else {
      const supportedExtensions = ["jpg", "jpeg", "png", "webp"];
      if (!supportedExtensions.includes(imageType)) {
        return new Response("Unsupported image type", { status: 400 });
      }

      const image = await env.imagesR2.get(r2Key);
      const imageBuffer = await image.arrayBuffer();
      if (!imageBuffer) {
        return new Response("Image not found", { status: 404 });
      }

      if (imageType === "webp" && !th) {
        webpImage = imageBuffer;
        await env.imagesCache.put(cacheKey, webpImage, {
          expirationTtl: cacheExpire,
        });
        return new Response(webpImage, {
          headers: { "Content-Type": "image/webp" },
        });
      }

      let imageData = await decodeImage(imageBuffer, imageType);

      if (th) {
        const originalWidth = imageData.width;
        const originalHeight = imageData.height;

        if (th != originalWidth) {
          const newHeight = (originalHeight * th) / originalWidth;

          await initResize(RESIZE_WASM);
          imageData = await resize(imageData, { height: newHeight, width: th });
        }
      }

      if (imageType !== "webp") {
        await initWebpEncWasm(WEBP_ENC_WASM);
        webpImage = await encodeWebp(imageData, {
          quality: qualityValue,
        });
      } else {
        await initWebpEncWasm(WEBP_ENC_WASM);
        webpImage = await encodeWebp(imageData);
      }

      await env.imagesCache.put(cacheKey, webpImage, {
        expirationTtl: cacheExpire,
      });
    }

    return new Response(webpImage, {
      headers: { "Content-Type": "image/webp" },
    });
  } catch (error) {
    console.error(error);
    return new Response("Error processing image", { status: 500 });
  }
}

export default {
  fetch: handleRequest,
};
