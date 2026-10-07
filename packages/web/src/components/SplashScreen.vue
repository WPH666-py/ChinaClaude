<script setup lang="ts">
/**
 * Launch splash.
 *
 * Rendered as an OVERLAY over the app rather than instead of it, so the shell keeps initialising
 * underneath — bridge connection, discovery, session adoption — and the main screen is ready the
 * moment this lifts. A splash that gated startup would trade a fixed delay for a variable one.
 *
 * The animation is 4 s and the bar runs longer, so the video LOOPS. That is deliberate: a 4 s clip
 * stretched to fill 7 s would have to be slowed down or frozen, and a loading animation that
 * visibly stalls reads as a hang.
 *
 * Autoplay is only possible because the file has NO audio track — verified before shipping: a
 * browser blocks autoplay for anything with sound, and the splash would then sit on a black
 * rectangle. H.264 was checked too, since WebView2 cannot decode HEVC without a system extension.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps<{
  /** How long the splash stays up. Named, not sprinkled as a literal, because it is a product choice. */
  durationMs: number
}>()

const emit = defineEmits<{
  (e: 'done'): void
}>()

const progress = ref(0)
const videoFailed = ref(false)
let frame = 0
let startedAt = 0

/** Percent complete, floored to 100 so the bar never reads 99% as the screen changes. */
const percent = computed(() => Math.min(100, Math.round(progress.value)))

onMounted(() => {
  startedAt = performance.now()
  const tick = () => {
    const elapsed = performance.now() - startedAt
    progress.value = (elapsed / props.durationMs) * 100
    if (elapsed >= props.durationMs) {
      progress.value = 100
      emit('done')
      return
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
})

onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <div class="splash">
    <div class="splash__row">
      <!-- Left: the animation. -->
      <div class="splash__media">
        <video
          v-if="!videoFailed"
          class="splash__video"
          src="/ChinaClaude-loading.mp4"
          autoplay
          muted
          loop
          playsinline
          @error="videoFailed = true"
        />
        <!--
          If the file is missing or undecodable the layout must not collapse into an empty box:
          the title still carries the screen, and the bar still runs.
        -->
        <div v-else class="splash__fallback">ChinaClaude</div>
      </div>

      <!-- Right: the name and the line that goes under it. -->
      <div class="splash__copy">
        <h1 class="splash__title">ChinaClaude</h1>
        <p class="splash__subtitle">图形化、平替化、Harness化，就选ChinaClaude！</p>
      </div>
    </div>

    <div class="splash__bar" role="progressbar" :aria-valuenow="percent" aria-valuemin="0" aria-valuemax="100">
      <span class="splash__barFill" :style="{ width: percent + '%' }" />
    </div>
  </div>
</template>

<style scoped>
.splash {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 34px;
  padding: 40px;
  background: #151517;
  /* Fades out rather than cutting, so the app appearing underneath is not a jolt. */
  animation: splashIn 0.45s ease both;
}

@keyframes splashIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

/* Left-right layout; stacks on a narrow window rather than squashing both columns. */
.splash__row {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 56px;
  max-width: 1000px;
}

.splash__media {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  width: 320px;
  height: 320px;
}

/*
 * Absolutely positioned, NOT width/height:100% on a flow item.
 *
 * Both `height:100%` and `max-height:100%` failed to resolve on this replaced element as a centred
 * grid item — it computed to the intrinsic aspect-ratio height (320x427 for the 250x334 source, then
 * 250x334 after switching to max-*), overflowing the box and covering the progress bar below it.
 * `inset: 0` gives it a definite containing block, so the percentages bind and `object-fit: contain`
 * letterboxes the animation inside without cropping it.
 */
.splash__video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* contain, not cover: the animation is the point and must not be cropped. */
  object-fit: contain;
  border-radius: 16px;
}

.splash__fallback {
  display: grid;
  place-items: center;
  width: 100%;
  height: 100%;
  border: 1px dashed #3a3a3d;
  border-radius: 16px;
  color: #6b6b70;
  font-size: 15px;
  letter-spacing: 0.08em;
}

.splash__copy {
  min-width: 0;
}

.splash__title {
  margin: 0 0 14px;
  color: #fff;
  font-size: 58px;
  font-weight: 700;
  letter-spacing: 0.01em;
  line-height: 1.05;
}

.splash__subtitle {
  margin: 0;
  color: #c9c9cf;
  font-size: 19px;
  line-height: 1.6;
}

.splash__bar {
  width: min(720px, 100%);
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: #2c2c2e;
}

.splash__barFill {
  display: block;
  height: 100%;
  border-radius: 2px;
  background: linear-gradient(90deg, #4d6bfe, #7d92ff);
  /* Linear, matching the rAF clock exactly — an eased bar would finish visually before or after the
     screen actually changes. */
  transition: width 80ms linear;
}

/* Narrow window: the animation sits above the words instead of both being squeezed. */
@media (max-width: 820px) {
  .splash__row {
    flex-direction: column;
    gap: 24px;
  }

  .splash__media {
    width: 200px;
    height: 200px;
  }

  .splash__title {
    font-size: 38px;
    text-align: center;
  }

  .splash__subtitle {
    font-size: 15px;
    text-align: center;
  }
}

/* The bar still runs; it just does not chase anything. */
@media (prefers-reduced-motion: reduce) {
  .splash {
    animation: none;
  }
}
</style>
