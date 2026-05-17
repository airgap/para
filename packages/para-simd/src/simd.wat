;; parabun-browser-shims simd kernels — f32 SIMD (v128) kernels.
;;
;; Memory layout: the module exports `mem` as the linear memory; JS
;; `alloc()` returns Float32Array views backed by this memory so inputs
;; can be operated on zero-copy. For TypedArrays NOT allocated here, the
;; JS wrapper copies in before the call. Outputs are always written
;; in-place at the caller-supplied `outPtr`.
;;
;; All offsets are byte offsets. All counts are element counts.
;;
;; Each kernel processes 4 elements per v128 op, then handles the 0–3
;; leftover elements with scalar loads/stores.

(module
  (memory (export "mem") 64)          ;; 4 MiB initial (64 × 64 KiB pages) — big enough
                                     ;; for typical call-scoped scratch
                                     ;; without growing (growth detaches
                                     ;; existing `alloc()` views).

  ;; out[i] = a[i] * k
  (func (export "mulScalar")
    (param $aPtr i32) (param $n i32) (param $k f32) (param $outPtr i32)
    (local $i i32) (local $end4 i32) (local $vk v128)
    (local.set $vk (f32x4.splat (local.get $k)))
    (local.set $end4 (i32.and (local.get $n) (i32.const 0xfffffffc)))
    (local.set $i (i32.const 0))
    (block $done_v
      (loop $v
        (br_if $done_v (i32.ge_s (local.get $i) (local.get $end4)))
        (v128.store
          offset=0 align=1
          (i32.add (local.get $outPtr) (i32.shl (local.get $i) (i32.const 2)))
          (f32x4.mul
            (v128.load offset=0 align=1
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
            (local.get $vk)))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $v)))
    (block $done_s
      (loop $s
        (br_if $done_s (i32.ge_s (local.get $i) (local.get $n)))
        (f32.store
          (i32.add (local.get $outPtr) (i32.shl (local.get $i) (i32.const 2)))
          (f32.mul
            (f32.load
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
            (local.get $k)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $s))))

  ;; out[i] = a[i] + k
  (func (export "addScalar")
    (param $aPtr i32) (param $n i32) (param $k f32) (param $outPtr i32)
    (local $i i32) (local $end4 i32) (local $vk v128)
    (local.set $vk (f32x4.splat (local.get $k)))
    (local.set $end4 (i32.and (local.get $n) (i32.const 0xfffffffc)))
    (local.set $i (i32.const 0))
    (block $done_v
      (loop $v
        (br_if $done_v (i32.ge_s (local.get $i) (local.get $end4)))
        (v128.store offset=0 align=1
          (i32.add (local.get $outPtr) (i32.shl (local.get $i) (i32.const 2)))
          (f32x4.add
            (v128.load offset=0 align=1
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
            (local.get $vk)))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $v)))
    (block $done_s
      (loop $s
        (br_if $done_s (i32.ge_s (local.get $i) (local.get $n)))
        (f32.store
          (i32.add (local.get $outPtr) (i32.shl (local.get $i) (i32.const 2)))
          (f32.add
            (f32.load
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
            (local.get $k)))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $s))))

  ;; out[i] = a[i] + b[i]
  (func (export "add")
    (param $aPtr i32) (param $bPtr i32) (param $n i32) (param $outPtr i32)
    (local $i i32) (local $end4 i32)
    (local.set $end4 (i32.and (local.get $n) (i32.const 0xfffffffc)))
    (local.set $i (i32.const 0))
    (block $done_v
      (loop $v
        (br_if $done_v (i32.ge_s (local.get $i) (local.get $end4)))
        (v128.store offset=0 align=1
          (i32.add (local.get $outPtr) (i32.shl (local.get $i) (i32.const 2)))
          (f32x4.add
            (v128.load offset=0 align=1
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
            (v128.load offset=0 align=1
              (i32.add (local.get $bPtr) (i32.shl (local.get $i) (i32.const 2))))))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $v)))
    (block $done_s
      (loop $s
        (br_if $done_s (i32.ge_s (local.get $i) (local.get $n)))
        (f32.store
          (i32.add (local.get $outPtr) (i32.shl (local.get $i) (i32.const 2)))
          (f32.add
            (f32.load
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
            (f32.load
              (i32.add (local.get $bPtr) (i32.shl (local.get $i) (i32.const 2))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $s))))

  ;; out[i] = a[i] * b[i]
  (func (export "mul")
    (param $aPtr i32) (param $bPtr i32) (param $n i32) (param $outPtr i32)
    (local $i i32) (local $end4 i32)
    (local.set $end4 (i32.and (local.get $n) (i32.const 0xfffffffc)))
    (local.set $i (i32.const 0))
    (block $done_v
      (loop $v
        (br_if $done_v (i32.ge_s (local.get $i) (local.get $end4)))
        (v128.store offset=0 align=1
          (i32.add (local.get $outPtr) (i32.shl (local.get $i) (i32.const 2)))
          (f32x4.mul
            (v128.load offset=0 align=1
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
            (v128.load offset=0 align=1
              (i32.add (local.get $bPtr) (i32.shl (local.get $i) (i32.const 2))))))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $v)))
    (block $done_s
      (loop $s
        (br_if $done_s (i32.ge_s (local.get $i) (local.get $n)))
        (f32.store
          (i32.add (local.get $outPtr) (i32.shl (local.get $i) (i32.const 2)))
          (f32.mul
            (f32.load
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
            (f32.load
              (i32.add (local.get $bPtr) (i32.shl (local.get $i) (i32.const 2))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $s))))

  ;; Σ a[i]
  (func (export "sum") (param $aPtr i32) (param $n i32) (result f32)
    (local $i i32) (local $end4 i32)
    (local $acc v128) (local $s f32)
    (local.set $end4 (i32.and (local.get $n) (i32.const 0xfffffffc)))
    (local.set $i (i32.const 0))
    (local.set $acc (f32x4.splat (f32.const 0)))
    (block $done_v
      (loop $v
        (br_if $done_v (i32.ge_s (local.get $i) (local.get $end4)))
        (local.set $acc
          (f32x4.add
            (local.get $acc)
            (v128.load offset=0 align=1
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $v)))
    (local.set $s
      (f32.add
        (f32.add
          (f32x4.extract_lane 0 (local.get $acc))
          (f32x4.extract_lane 1 (local.get $acc)))
        (f32.add
          (f32x4.extract_lane 2 (local.get $acc))
          (f32x4.extract_lane 3 (local.get $acc)))))
    (block $done_s
      (loop $s_l
        (br_if $done_s (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $s
          (f32.add
            (local.get $s)
            (f32.load
              (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $s_l)))
    (local.get $s))

  ;; Σ a[i] * b[i]
  (func (export "dot")
    (param $aPtr i32) (param $bPtr i32) (param $n i32) (result f32)
    (local $i i32) (local $end4 i32)
    (local $acc v128) (local $s f32)
    (local.set $end4 (i32.and (local.get $n) (i32.const 0xfffffffc)))
    (local.set $i (i32.const 0))
    (local.set $acc (f32x4.splat (f32.const 0)))
    (block $done_v
      (loop $v
        (br_if $done_v (i32.ge_s (local.get $i) (local.get $end4)))
        (local.set $acc
          (f32x4.add
            (local.get $acc)
            (f32x4.mul
              (v128.load offset=0 align=1
                (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
              (v128.load offset=0 align=1
                (i32.add (local.get $bPtr) (i32.shl (local.get $i) (i32.const 2)))))))
        (local.set $i (i32.add (local.get $i) (i32.const 4)))
        (br $v)))
    (local.set $s
      (f32.add
        (f32.add
          (f32x4.extract_lane 0 (local.get $acc))
          (f32x4.extract_lane 1 (local.get $acc)))
        (f32.add
          (f32x4.extract_lane 2 (local.get $acc))
          (f32x4.extract_lane 3 (local.get $acc)))))
    (block $done_s
      (loop $s_l
        (br_if $done_s (i32.ge_s (local.get $i) (local.get $n)))
        (local.set $s
          (f32.add
            (local.get $s)
            (f32.mul
              (f32.load
                (i32.add (local.get $aPtr) (i32.shl (local.get $i) (i32.const 2))))
              (f32.load
                (i32.add (local.get $bPtr) (i32.shl (local.get $i) (i32.const 2)))))))
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $s_l)))
    (local.get $s)))
