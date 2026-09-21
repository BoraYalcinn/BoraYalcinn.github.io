---
title: "MonoCUDA Dev Log #1"
date: 2026-09-17
draft: false
description: "Starting MonoCUDA, a single-file CUDA path tracer: the CUDA
  basics, ray-sphere and ray-triangle intersection, and getting a camera to fire
  the first rays."
categories:
  - Dev
tags:
  - cuda
  - path-tracing
  - computer-graphics
  - graphics-programming
  - gpu
cover: /images/blog/renderv2.jpg
featured: false
---
Hi everyone, this is my first blog post and dev log number one for my new project, **MonoCUDA**, a path tracer I'm building in CUDA, in a single file. In this post I'll go over what I've learned about CUDA so far, what I've covered in the project, and some of the math essentials for a project like this. All the drawings in this post are my own, and I tried my best to visualize how I think about the math and the calculations. So let's get started!

## Why this project

The idea came to me while reading Peter Shirley's *Ray Tracing in One Weekend*. When I finished the first book and rendered the final scene, it pinned my CPU at 100% and took a genuinely long time to finish. I guess that's exactly why we have GPUs nowadays. Path tracing is one of those areas of computer graphics where multithreading, the GPU, and parallel computing really matter. Every pixel's ray is an independent unit of work, which is about as good a fit for a GPU as you can get.

## Getting to know the hardware first

The first thing I did was write a function to fetch my device's GPU capabilities. This matters because NVIDIA ships all kinds of different architectures and GPU classes. Mine is an RTX 5070 Laptop GPU; yours might be something completely different, with a different number of SMs (streaming multiprocessors) and a different amount of parallelism available.

For block/grid sizing I'm currently using a hardcoded `16x16` block, which works reasonably well across most GPUs since it's a multiple of the warp size (32) and comfortably under the per-block thread limit. In the coming days I want to replace this with something that isn't hardcoded, ideally using CUDA's own occupancy calculator instead of a number I picked by hand.

## CUDA basics I had to internalize

In CUDA, parallelism happens through **kernels** and **threads**, using the `__host__` and `__device__` keywords. If a function is marked with both, it means it can be compiled and run on *both* the CPU and the GPU, which is useful for math helpers you want to call from either side.

Kernel calls are what actually run on the GPU: many blocks, each with many threads, running concurrently. It's not quite "random", since threads are grouped into warps of 32 and scheduled by the hardware, but you don't get to control the exact order things execute in, so you can't rely on one thread's result being ready when another thread runs. That's an important mental shift coming from single-threaded CPU code.

Error handling in CUDA also has two separate layers, which caught me off guard at first:

- **API call errors.** Things like `cudaMalloc` or `cudaMemcpy` return a `cudaError_t` directly, so you can check them right where they happen.
- **Kernel errors.** A kernel launch doesn't return anything, so you have to check `cudaGetLastError()` (for launch configuration errors) and `cudaDeviceSynchronize()` (for runtime errors that only surface once the kernel actually executes) separately, after the launch.

I wrapped both into small macros early on:

```cpp
#define CUDA_CHECK(call)                                                     \
    do {                                                                     \
        cudaError_t err__ = (call);                                         \
        if (err__ != cudaSuccess) {                                          \
            std::fprintf(stderr, "CUDA error at %s:%d: %s\n", __FILE__,      \
                          __LINE__, cudaGetErrorString(err__));              \
            std::exit(EXIT_FAILURE);                                        \
        }                                                                    \
    } while (0)

#define CUDA_CHECK_KERNEL()                                                  \
    do {                                                                     \
        CUDA_CHECK(cudaGetLastError());                                      \
        CUDA_CHECK(cudaDeviceSynchronize());                                 \
    } while (0)
```

Given all this, the obvious move was to make the render function itself a kernel, so the actual heavy lifting happens on the GPU instead of the CPU.

## First image: gradient, then rasterization

The very first thing I rendered was a gradient going from the top-left to the bottom-right. That's just the direction I like starting with; it feels natural to me.

<!-- TODO: gradient render'ı yükle, sonra bu satırı geri aç:
![gradient render, an early test image](/images/blog/GORSEL.jpg)
-->

Before jumping into actual ray tracing, I warmed up with rasterization: I printed a white triangle on screen using the classic **edge function** test: for a point to be inside a triangle, it needs to fall on the same side of all three edges.

![rasterized white triangle](/images/blog/renderv1.jpg)

```cpp
__device__ float edge_function(const vec3& a, const vec3& b, const vec3& c) {
    return (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
}
```

## Things get more complicated: ray tracing

Rasterization and ray/path tracing are nothing alike. Instead of projecting triangles onto the screen, we send a ray out from the camera for every pixel and figure out what it hits. And once we get to actual path tracing, we'll be bouncing those rays around the scene, which adds a ton more calculation. But first, the essentials: spheres and triangles. Triangles in particular matter for the future, since almost anything (any mesh, any loaded 3D object) eventually breaks down into triangles.

### Ray-sphere intersection

So let's say we're sending a ray toward a sphere. What do we actually need to know to figure out if it hits? If you guessed "does the ray's closest approach to the sphere's center stay inside the radius," you're exactly right.

![ray-sphere geometry: the discriminant as d versus r](/images/blog/path-tracingsphere.jpg)

Geometrically: find the point on the ray closest to the sphere's center, measure the distance `d` from the center to that point, and compare it to the radius `r`. If `d > r`, the ray misses entirely. If `d ≤ r`, it hits, and the exact hit distance comes from a bit of Pythagoras, since `d`, the radius, and the half-chord length of the intersection form a right triangle.

```cpp
__device__ bool hit_sphere(const sphere& targetSphere, const vec3& rayOrigin,
                            const vec3& rayDirection, float& intersectionDistance) {

    vec3 vectorFromRayOriginToSphereCenter = targetSphere.center - rayOrigin;

    float distanceToClosestPointOnRay =
        vectorFromRayOriginToSphereCenter.dot(rayDirection) / rayDirection.dot(rayDirection);

    vec3 closestPointOnRay = rayOrigin + rayDirection * distanceToClosestPointOnRay;

    float distanceSquaredFromCenterToClosest =
        (targetSphere.center - closestPointOnRay).length_squared();

    float discriminant =
        targetSphere.radius * targetSphere.radius - distanceSquaredFromCenterToClosest;

    if (discriminant < 0.0f) {
        return false;   // ray never comes within radius of the center
    }

    float halfChordLength = sqrtf(discriminant);
    intersectionDistance = distanceToClosestPointOnRay - halfChordLength;
    return true;
}
```

What's neat is that this is algebraically the same thing as solving the classic quadratic form `at² + bt + c = 0` and checking its discriminant: `r² - d²` here *is* `b² - 4ac` after simplifying, just arrived at from a geometric direction instead of a purely algebraic one. Same test, two ways of seeing it.

### Ray-triangle intersection

And what about a triangle? A triangle isn't a volume like a sphere; it's a flat, finite patch floating in space, so a ray can only cross it once (assuming it's not parallel to the triangle's plane). That splits the problem into two steps: first find where the ray hits the *infinite plane* the triangle lies on, then check whether that point actually falls inside the triangle's three edges.

![ray-triangle plane intersection and edge test](/images/blog/path-tracingtriangle.jpg)

```cpp
__device__ bool hit_triangle(const triangle& tri, const vec3& rayOrig,
                              const vec3& rayDir, float& intersectionDistance) {
    vec3 edge1 = tri.v1 - tri.v0;
    vec3 edge2 = tri.v2 - tri.v0;
    vec3 triangleNormal = edge1.cross(edge2).normalize();

    float denominator = rayDir.dot(triangleNormal);
    if (fabsf(denominator) < 1e-6f) return false; // ray parallel to the plane

    float t = (tri.v0 - rayOrig).dot(triangleNormal) / denominator;
    if (t < 0.0001f) return false;

    vec3 hitPoint = rayOrig + rayDir * t;

    // inside/outside test: same edge function as the rasterizer, generalized to 3D
    vec3 edge0 = tri.v1 - tri.v0;
    if (triangleNormal.dot(edge0.cross(hitPoint - tri.v0)) < 0) return false;

    vec3 edge1b = tri.v2 - tri.v1;
    if (triangleNormal.dot(edge1b.cross(hitPoint - tri.v1)) < 0) return false;

    vec3 edge2b = tri.v0 - tri.v2;
    if (triangleNormal.dot(edge2b.cross(hitPoint - tri.v2)) < 0) return false;

    intersectionDistance = t;
    return true;
}
```

This second step is the same edge function idea from my rasterization test earlier, just lifted from 2D screen space into 3D: instead of a single 2D cross product, each edge test is a 3D cross product projected onto the triangle's normal.

## Now we need a camera

We know how to test rays against geometry, but we still haven't talked about where the rays actually come from. When we send a ray per pixel, that pixel is really a point on an imaginary window in front of the camera, called the **viewport**, and figuring out exactly where that point sits in 3D space is another round of math.

![camera and viewport geometry: u, v, w and pixel(0,0)](/images/blog/path-tracingviewport.jpg)

The camera first builds its own little coordinate system out of `look_from`, `look_at`, and `up`:

$$w = \frac{\text{look\_from} - \text{look\_at}}{\lVert \text{look\_from} - \text{look\_at} \rVert}, \quad u = \frac{\text{up} \times w}{\lVert \text{up} \times w \rVert}, \quad v = w \times u$$

Then the vertical field of view (`vfov`) and a bit of trigonometry give us the physical size of the viewport at the given focus distance:

$$\theta = \text{vfov} \cdot \frac{\pi}{180}, \quad h = \tan\left(\frac{\theta}{2}\right), \quad \text{viewport\_height} = 2h \cdot \text{focus\_distance}$$

From there, the viewport's edges become real 3D vectors (`u` scaled by width, `v` scaled by height), which get divided by the image resolution to find out how much space a single pixel actually covers, and finally, the very first pixel's center position:

```cpp
__host__ __device__ void initialize() {
    w = (look_from - look_at).normalize();
    u = up.cross(w).normalize();
    v = w.cross(u);

    image_height = int(image_width / aspec_ratio);
    center = look_from;

    float theta = degrees_to_radians(vfov);
    float h = tanf(theta / 2.0f);
    float viewport_height = 2.0f * h * focus_distance;
    float viewport_width = viewport_height * (float(image_width) / image_height);

    vec3 viewport_u = u * viewport_width;
    vec3 viewport_v = v * -viewport_height;

    pixel_delta_u = viewport_u / float(image_width);
    pixel_delta_v = viewport_v / float(image_height);

    vec3 viewport_upper_left =
        center - (w * focus_distance) - viewport_u / 2.0f - viewport_v / 2.0f;
    pixel00_location = viewport_upper_left + (pixel_delta_u + pixel_delta_v) * 0.5f;
}
```

And then getting an actual ray for pixel `(i, j)` is just walking across that grid:

```cpp
__device__ ray getRay(int i, int j) const {
    vec3 pixelCenter = pixel00_location + (pixel_delta_u * float(i)) + (pixel_delta_v * float(j));
    vec3 rayDirection = (pixelCenter - center).normalize();
    return ray(center, rayDirection);
}
```

## Where things stand

With that, I can now check off camera setup, analytic sphere/triangle intersection, and getting the first real 3D scene on screen: a normal-colored sphere and triangle, floating in front of a sky gradient.

![first real 3D render: sphere and triangle with normal-debug shading](/images/blog/renderv2.jpg)

