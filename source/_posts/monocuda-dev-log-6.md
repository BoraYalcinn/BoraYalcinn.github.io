---
title: "MonoCUDA Dev Log #6"
date: 2026-11-06
description: "Loading Sponza from an OBJ with no dependencies, and then keeping the GPU busy: wavefront path tracing, a 32 byte AABB, and persistent threads in the extend kernel."
categories:
  - Dev
tags:
  - cuda
  - path-tracing
  - computer-graphics
  - graphics-programming
  - performance
  - profiling
  - gpu
cover: /images/blog/sponza-textured.png
featured: true
published: true
---
<!-- SKELETON. Bullets are notes to expand into prose. Numbers are from the
     MonoCUDA-PT README and are measured; do not round them. -->

## Where we left off

- Log 5 ended with motion blur, lights and NEE, all of it on the Cornell box.
- On that scene the two execution models were the same speed: megakernel
  **13.99 s** vs wavefront **13.81 s**, 1.01x. Not a result, a sign the scene
  was too small to tell them apart.
- 24 triangles and a handful of spheres fit in cache and never diverge. To
  measure anything the renderer needed a scene that actually hurts.
- So this log is two halves: getting a real model in, and then making it fast.

## Loading real geometry: OBJ and MTL

- Wavefront OBJ parser written from scratch, no library. Handles `v`, `vt`,
  `f`, negative (relative) indices, and fan triangulation for faces with more
  than three vertices.
- The model is centred, scaled and rotated around Y on load, so a downloaded
  OBJ lands in front of the camera instead of somewhere off in world space.
- MTL: `newmtl`, `Kd` and `map_Kd` only. Everything else ignored.
- Textures must be binary PPM (P6, 8 bit), converted once offline with
  ImageMagick. Why: the project is still one file with zero dependencies, so
  there is no `stb_image` and no image decoder of any kind.
- Sponza: **262,268 triangles**, **24 textures**, lit by a single skylight quad
  above the open roof.
- Honest limitations, worth stating plainly:
  - alpha-masked parts (leaves, chains, plants) render as solid quads
  - no gamma and no tone mapping yet, so everything looks darker and flatter
    than the same scene in other renderers

I should be upfront about this part: there is not much of me in it. I did not
think very hard about the loader, and I did not need to. OBJ parsing is a solved
problem with a hundred implementations out there, so I read one, understood what
it was doing, and wrote my own version of the same thing. It loads the file and
it gets out of the way, which is all I wanted from it. If you are writing one
yourself you can almost certainly do better than mine, and the interesting part
of this log starts after the model is in memory anyway.

![Sponza loaded but untextured, every surface on the placeholder material](/images/blog/sponza-untextured.png)

- Then with the MTL materials and the 24 textures actually loaded:

![the same view with the MTL materials and textures loaded, coloured curtains and a tiled floor](/images/blog/sponza-textured.png)

## Why Sponza hurts: wavefront path tracing

- Recap of the split, short: `extendKernel` traverses, `shadeKernel` shades and
  spawns, `shadowKernel` does the NEE visibility test.
- Queues are compacted between stages so a dead path stops costing anything.
- Path state is SoA, one array per field, so a warp reads 32 contiguous floats
  instead of 32 strided structs.
- Now the two models separate properly. 600x600, 1000 spp, max depth 20, RTX
  5070 Laptop GPU (36 SMs), render loop only, BVH build excluded:

| Scene | Geometry | Single-kernel | Wavefront | Speedup |
|---|---|---|---|---|
| Cornell box | 24 triangles + spheres | 13.99 s | 13.81 s | 1.01x |
| Sponza atrium | 262,268 triangles | 191.44 s | 105.36 s | 1.82x |

- One paragraph on the `AABB` layout: it was 36 bytes, it is now **32 bytes and
  16 byte aligned**, so one box is two 16 byte vector loads instead of a
  straddling mess.

| Sponza, wavefront, 1000 spp | Time | Mpaths/s | Speedup |
|---|---|---|---|
| Before (36 byte `AABB`, placeholder material) | 105.36 s | 3.42 | 1.00x |
| After (32 byte aligned `AABB`, MTL textures loaded) | 88.01 s | 4.09 | 1.20x |

- Caveat to keep: the two runs differ in more than the layout, since the second
  also renders the textured Sponza, which adds shading work. So the layout
  change alone is probably worth slightly more than 1.20x.
- Nsight's estimated remaining speedup for `extendKernel` fell from about 63%
  to 46.6%, and the kernel became compute-limited (57% of peak) rather than
  memory-limited (30% of peak).
- The single-kernel renderer has not been re-measured since this change.

![Nsight Compute's source view: the two AABB loads inside the traversal loop](/images/blog/nsight-traversal-loads.png)

## Persistent threads in the extend kernel

- The problem this solves: a warp traverses 32 rays together, they finish at
  wildly different depths, and the lanes that finished sit idle until the
  slowest one is done.
- The idea: stop launching one thread per ray. Launch a fixed grid that exactly
  fills the GPU (SM count times resident blocks per SM) and let a finished lane
  pull a new ray from a global work counter.
- Mechanics worth one paragraph each:
  - refill when **at least 8 lanes** of a warp are idle, not immediately
  - one warp-aggregated `atomicAdd` for the whole warp, not one per lane
  - slots handed out with a prefix popcount (`__ffs`, `__ballot_sync`, `__popc`)
  - `traverseRay` split into `beginTraversal` and `stepTraversal` so a lane can
    carry its ray state across loop iterations

```cpp
unsigned int idleLaneMask = __ballot_sync(fullWarpMask, !laneHasRay);
int idleLaneCount = __popc(idleLaneMask);

if (idleLaneCount >= minimumIdleLanesBeforeRefill) {
    int firstIdleLane = __ffs(idleLaneMask) - 1;
    int firstQueueSlot = 0;
    if (laneIndex == firstIdleLane) firstQueueSlot = atomicAdd(workCounter, idleLaneCount);
    firstQueueSlot = __shfl_sync(fullWarpMask, firstQueueSlot, firstIdleLane);
    // ... each idle lane takes firstQueueSlot + its rank among the idle lanes
}
```

| Sponza, wavefront, 1000 spp | Time | Mpaths/s | Speedup |
|---|---|---|---|
| Normal extend kernel | 88.11 s | 4.09 | 1.00x |
| Persistent threads (`--persistent`) | 78.23 s | 4.60 | 1.13x |

- Both rows measured back to back in the same session.
- Nsight on the extend kernel at bounce depth 3:
  - average active threads per warp **6.35 to 15.33**
  - kernel time **18.2 ms to 10.2 ms**
  - registers per thread **71 to 56**

![Nsight Compute on the persistent extend kernel: 10.26 ms, 56 registers, 82.27% memory throughput](/images/blog/nsight-persistent-extend.png)

- Why the whole frame only gains 1.13x when the kernel nearly halves: `nsys`
  puts the persistent extend kernel at 66% of GPU time, the shadow-ray kernel
  at 28%, the shade kernel at 3%. Amdahl, in one line.
- The image is **byte-identical** to the normal wavefront renderer, checked
  with `cmp`. Every ray does the same work in the same order; only who does it
  changed.
- Where it is now stuck: the extend kernel is memory-limited, about 80% of peak,
  mostly local memory traffic from the traversal stack and scattered stores of
  the hit results.

## What did not work

- **Persistent threads in the shadow kernel.** Same technique, same measurement
  showing it worked by the divergence metric: active threads per warp
  **12.66 to 18.09**. And the kernel got *slower*: **4.10 ms to 4.31 ms**,
  about **5% slower** overall. Reverted.
  - The lesson is the one worth writing the section for: a better divergence
    number does not mean a faster kernel. Shadow rays are short and terminate
    early, so there was little idle time to reclaim, and the refill bookkeeping
    cost more than it saved.
- **`__ldg` on the scene and material reads.** No measurable gain. Profiling
  already showed plain `LDG.E` loads, and making them explicit changed nothing.
  <!-- TODO(bora): say whether const __restrict__ is still worth trying, or drop
       this bullet if it reads as filler -->

## A break, and a proper Sponza

I am going to take a break from this series here. School is school, I have other
projects running, and my attention is drifting toward some fairly different
areas at the moment. None of that means the project stops. MonoCUDA-PT keeps
going, I just will not be writing a log every time I move something by a few
percent. When there is something genuinely worth showing, a visual milestone or
a performance jump big enough to be interesting, I will write about it.

And this feels like the right place to pause. The renderer can load a real model
now, and the model it is loading is Sponza, which is about as classic as test
scenes get. Stopping on that is a lot nicer than stopping on another Cornell
box. If you want to follow where it goes next, the repo is the place:
[github.com/BoraYalcinn/MonoCUDA-PT](https://github.com/BoraYalcinn/MonoCUDA-PT)

Thank you for reading these. Writing them taught me more than the code did.

<!-- TODO(bora): final image, high-spp classic Sponza render. Placeholder only,
     no claims about it written yet. -->

- See you when there is something worth showing.
