// Rune-style interop for para signals in Svelte 5.
//
// Para signals and Svelte runes are two independent reactive systems
// that don't observe each other's reads. The bridge: subscribe to the
// signal from inside an effect and forward each value into a $state
// cell. Writes go straight back to the signal.
//
// Usage:
//
//   <script lang="parabun">
//     import { paraState } from "@lyku/para-signals/svelte";
//     let { count } = $props();           // count is a para signal
//     const live = paraState(() => count); // wrap once; tracks prop swap
//   </script>
//
//   <button onclick={() => live.value++}>{live.value}</button>
//   <input bind:value={live.value} />
//
// Pass a signal directly when the identity is stable; pass a getter
// when it can change (e.g. a prop the parent may re-bind).

/**
 * @template T
 * @param {import('./src/index.js').Signal<T> | (() => import('./src/index.js').Signal<T>)} source
 * @returns {{ value: T }}
 */
export function paraState(source) {
  const get = typeof source === "function" ? source : () => source;
  let v = $state.raw(get().peek());
  $effect(() =>
    get().subscribe(next => {
      v = next;
    }),
  );
  return {
    get value() {
      return v;
    },
    set value(next) {
      get().set(next);
    },
  };
}
