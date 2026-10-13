<script setup lang="ts">
/**
 * 休闲食品商城 — the author's own storefront, kept in the app.
 *
 * WHY IT IS IN A DEVELOPER TOOL AT ALL: it is in the reference app, it is the author's, and the
 * products are real. The images ship INSIDE the installer (`public/shop/*.jpg`) rather than being
 * hot-linked, so the window renders on a machine that cannot reach the shop host — which is the
 * normal case for the users this build exists for.
 *
 * The buttons are plain links with `target="_blank"`: the app never proxies a purchase, and it never
 * claims an order went anywhere.
 */
import { onMounted, ref } from 'vue'
import ShellDialog from './ShellDialog.vue'
import { shellGet } from '../composables/useShellApi'

interface Product {
  image: string
  name: string
  detail: string
  url: string
}

const emit = defineEmits<{ (e: 'close'): void }>()

const products = ref<Product[]>([])
const error = ref<string | null>(null)
const loading = ref(true)

/** Bundled at build time, so a missing image is a build problem rather than a network one. */
function imageFor(name: string): string {
  return `${import.meta.env.BASE_URL}shop/${name}`
}

onMounted(async () => {
  try {
    const answer = await shellGet<{ products: Product[] }>('/api/shop/catalog')
    products.value = answer.products
  } catch (problem) {
    error.value = problem instanceof Error ? problem.message : String(problem)
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <ShellDialog title="休闲食品商城" meta="作者自家店，图片随包内置" :width="860" @close="emit('close')">
    <p class="sh__lead">
      写代码的时候总得有点嚼的。这些是作者自己店里的东西，价格与库存以店铺页面为准；
      点开就是拼多多商品页，本应用不参与交易、也拿不到任何订单信息。
    </p>

    <div v-if="error" class="sh__error">{{ error }}</div>
    <div v-else-if="loading" class="sh__waiting"><span class="spinner" />正在读取商品…</div>

    <div v-else class="sh__grid">
      <a v-for="product in products" :key="product.name" class="sh__card" :href="product.url" target="_blank" rel="noreferrer">
        <img class="sh__img" :src="imageFor(product.image)" :alt="product.name" loading="lazy" />
        <span class="sh__name">{{ product.name }}</span>
        <span class="sh__detail">{{ product.detail }}</span>
        <span class="sh__go">去店铺看看 →</span>
      </a>
    </div>

    <template #footer>
      <span>共 {{ products.length }} 件 · 图片随安装包发布，离线也能看</span>
    </template>
  </ShellDialog>
</template>

<style scoped>
.sh__lead {
  margin: 0 0 14px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 19px;
}

.sh__waiting {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 26px 4px;
  color: var(--dsw-alias-label-caption);
  font-size: 12.5px;
}

.sh__error {
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-state-error-primary);
  border-radius: 8px;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
}

.sh__grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.sh__card {
  display: flex;
  flex-direction: column;
  padding: 9px;
  border: 0.5px solid var(--dsw-alias-border-l1);
  border-radius: 12px;
  background: var(--dsw-alias-bg-layer-1);
  text-decoration: none;
  transition: background 120ms ease;
}

.sh__card:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.sh__img {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  object-fit: cover;
  background: var(--dsw-alias-bg-skeleton);
}

.sh__name {
  margin-top: 8px;
  color: var(--dsw-alias-label-primary);
  font-size: 12.5px;
  font-weight: 500;
  line-height: 18px;
}

.sh__detail {
  margin-top: 3px;
  color: var(--dsw-alias-label-caption);
  font-size: 11px;
  line-height: 17px;
}

.sh__go {
  margin-top: 7px;
  color: var(--dsw-alias-state-business-primary);
  font-size: 11.5px;
}
</style>
