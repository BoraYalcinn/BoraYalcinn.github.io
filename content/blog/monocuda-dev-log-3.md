---
title: "MonoCUDA Dev Log #3"
date: 2026-10-01
draft: false
description: "Mirrors and glass: reflect and refract, Snell's law, the Schlick approximation, a fuzz parameter for rough metal, and three broken renders caused by applying the same formula upside down."
categories:
  - Dev
tags:
  - cuda
  - path-tracing
  - computer-graphics
  - graphics-programming
  - monte-carlo
  - gpu
cover: /images/blog/render-v10.jpg
featured: false
---
Hi everyone. I know it has been a while since the last dev log and I am sorry
about that. School has been busy and I could not find the time to get everything
together, the figures included. The fourth one will not take this long, mostly
because it is already close to finished.

So where were we? Here is the last render from the second log:

![where the second dev log ended: a red diffuse sphere and a triangle on a green ground sphere, lit only by the sky](/images/blog/render-v5.jpg)

Last time I gave the camera a real lens, put a floor under the scene by making
it an enormous sphere, and got Lambertian diffuse bouncing working so the thing
became an actual path tracer instead of a normal visualiser. Russian roulette
went in as well, and the render kernel got split in two.

Today the list is:

- `reflect()` and `refract()` on `vec3`
- `specular_scatter_direction()`, which is what a mirror does
- `dielectric_scatter_direction()`, which is what glass does
- Snell's law, total internal reflection, and the Schlick approximation
- A fuzz parameter, so metal can be rough instead of perfect
- And the mistake I made in `refract()`, twice, in opposite directions

Let's get started.

## Everything in that render is matte

Look at the image above again. I am not going to pretend it is exciting. Every
surface in it is diffuse, which means every surface scatters light in a random
direction and nothing in the scene reflects anything else. No mirrors, no glass,
no highlights. The scene has correct lighting and nothing to look at.

So the job for this log is materials. Before any of them could exist, though,
the renderer had to be able to answer a question it could not answer before:
what *kind* of surface did this ray hit? Until now a hit gave back an albedo and
nothing else. Every primitive stored a `vec3 albedo` and the bounce loop always
called the Lambertian scatter function, because there was nothing else to call.

The first change was to delete those albedo fields and give every primitive a
`Material` instead:

```cpp
enum class MaterialType { Lambertian, Dielectric, Conductor, Emissive };

struct Material {
    MaterialType type;
    vec3  albedo;
    vec3  emittedColor;
    float fuzz;
    float refractionIndex;
};
```

I wrote about this struct at the end of the last log, before anything used it.
One struct with a type tag, switched on in the shading code, rather than a base
class with virtual `scatter()` overrides. Virtual dispatch would make threads in
the same warp diverge, and a vtable pointer built on the host does not survive
the copy to the device. Now that two more materials exist, the switch is real:

```cpp
vec3 newDirection;
switch (hit.mat.type) {
    case MaterialType::Conductor: {
        vec3 reflected = specular_scatter_direction(r.direction, hit.hitNormal);
        newDirection = (reflected + random_unit_vector(&rngState) * hit.mat.fuzz).normalize();
        break;
    }
    case MaterialType::Dielectric: {
        float ratio;
        if (hit.frontFace) { ratio = 1.0f / hit.mat.refractionIndex; }
        else               { ratio = hit.mat.refractionIndex; }
        newDirection = dielectric_scatter_direction(r.direction, hit.hitNormal, ratio, &rngState);
        break;
    }
    case MaterialType::Lambertian:
    default:
        newDirection = lambertian_scatter_direction(hit.hitNormal, &rngState);
        break;
}
```

Hold on to that `ratio` for a few minutes. It is where all the trouble came
from.

The test scene became three spheres side by side on the green ground: a red
diffuse one in the middle, a mirror on the right, glass on the left. The
triangle went away, since three spheres of three materials is the clearest test
you can build.

## Mirrors: reflect

A mirror is the easiest material there is, because there is no randomness in it
at all. One incoming direction, one outgoing direction, done.

![reflection geometry: the incoming vector split into its components along the normal and the surface, and the derivation of R = I - 2(I·N)N](/images/blog/reflection.png)

The way I think about it: write the incoming vector as two pieces, the part
along the normal and the part along the surface. Reflection keeps the surface
part exactly as it was and flips the normal part. Since the normal is a unit
vector, the length of the normal part is just the dot product, and the whole
thing collapses to one line:

$$R = I - 2(I \cdot N)N$$

```cpp
__host__ __device__ vec3 reflect(const vec3& surfaceNormal) {
    return *this - surfaceNormal * (2.0f * this->dot(surfaceNormal));
}

__device__ vec3 specular_scatter_direction(const vec3& incomingLightDirection,
                                           const vec3& surfaceNormal) {
    return incomingLightDirection.normalize().reflect(surfaceNormal);
}
```

That is a perfect mirror, and a perfect mirror is not a material most things in
the world are made of. Real metal is rough at a scale you cannot see, so it
reflects *roughly* in the mirror direction instead of exactly along it. The
cheap version of that is a fuzz parameter: take the reflected direction, add a
random vector scaled by how rough the surface is, and normalise.

![specular scatter: the mirror direction, with fuzz pushing the outgoing ray into a small cone around it](/images/blog/specular-scatter.png)

```cpp
vec3 reflected = specular_scatter_direction(r.direction, hit.hitNormal);
newDirection = (reflected + random_unit_vector(&rngState) * hit.mat.fuzz).normalize();
```

With `fuzz = 0` you get a mirror. Turn it up and the reflection smears out into
a brushed-metal look. The fuzz is clamped to 1 in the material constructor,
because past that the random vector is longer than the reflected one and rays
start getting scattered into the surface itself.

This is an ad-hoc roughness model, not a real one. A proper microfacet BSDF with
a GGX distribution is the right way to do it, and it is on the checklist as a
later job.

## Glass: refract

Glass is where it gets interesting, because a ray that hits glass does not do
one thing. It splits. Part of the light bounces off the surface, part of it
passes through and bends. The bending is Snell's law:

$$n_1 \sin\theta_1 = n_2 \sin\theta_2$$

![Snell's law: the angle of refraction from the ratio of the two indices, the total internal reflection case, and the single-line vector form](/images/blog/refraction.png)

Rearranged for what we want, the outgoing angle, that is

$$\sin\theta_2 = \frac{n_1}{n_2} \sin\theta_1$$

and that fraction, the ratio of the two indices of refraction, is the number the
code passes around as `refraction_cof`. The caller builds it from which side of
the surface the ray is on. Coming from air into glass, it is `1.0 / 1.5`. Going
from the glass back out into air, it is `1.5`.

There is a cleaner way to write refraction as a single vector expression, which
is the formula in the bottom right of my figure, but I wrote it with explicit
trigonometry on purpose. I wanted to see each angle while I was learning it:

```cpp
__host__ __device__ vec3 refract(const vec3& surfaceNormal, float refraction_cof) {
    vec3 direction = this->normalize();
    float cosTheta1 = fminf((-direction).dot(surfaceNormal), 1.0f);
    float theta1 = acosf(cosTheta1);

    float sinTheta2 = sinf(theta1) * refraction_cof;
    if (sinTheta2 > 1.f) {
        return direction.reflect(surfaceNormal);
    }
    float theta2 = asinf(sinTheta2);

    vec3 tangent = direction + surfaceNormal * cosTheta1;
    float tangentLength = tangent.length();
    if (tangentLength > 1e-8f) {
        tangent = tangent / tangentLength;
    }
    return tangent * sinf(theta2) - surfaceNormal * cosf(theta2);
}
```

Notice the check in the middle. A sine cannot be larger than 1, so if the maths
asks for one, there is no refracted direction at all and every bit of the light
reflects instead. That is **total internal reflection**, and it is not an edge
case you can skip: it is why the underside of a water surface looks like a
mirror, and it is a large part of why glass renders look like glass.

### Which part reflects, and which part passes through

Even when refraction is possible, not all of the light goes through. The split
depends on the viewing angle. Looking straight down into a window you mostly see
through it; looking along it at a shallow angle you mostly see a reflection.

The exact answer is the Fresnel equations. They give the reflectance separately
for the two polarisations of light, and evaluating them properly costs a square
root and a handful of divisions. That is a lot to pay for something a path
tracer asks about at every bounce of every sample, so almost nobody evaluates
them directly. The standard shortcut is **Schlick's approximation**:

$$R(\theta) = R_0 + (1 - R_0)\,(1 - \cos\theta)^5$$

where \(R_0\) is the reflectance when you look straight at the surface, built
from the two indices of refraction:

$$R_0 = \left(\frac{n_1 - n_2}{n_1 + n_2}\right)^2$$

Put air and glass into that and you get a number worth remembering:

$$R_0 = \left(\frac{1 - 1.5}{1 + 1.5}\right)^2 = 0.04$$

Four percent. Looking straight at a window, 96% of the light goes through it and
4% comes back at you. That is why a window reflects you at night and not at
noon: the 4% is always there, it just loses to the daylight coming the other
way. The \((1 - \cos\theta)^5\) term is what takes that 4% up toward 100% as
your angle to the surface gets shallow, which is the whole behaviour the
approximation exists to reproduce. Two lines of code for something that would
otherwise be a page of optics:

```cpp
__device__ float schlick_approx(float cosine, float refraction_cof) {
    float r0 = (1.f - refraction_cof) / (1.f + refraction_cof);
    r0 = r0 * r0;
    return r0 + (1.f - r0) * powf((1 - cosine), 5.f);
}
```

Now, a path tracer traces one ray at a time, so it cannot send 8% of a ray one
way and 92% the other. What it does instead is pick one of the two, at random,
with Schlick's number as the probability. Average enough samples and the ratio
comes out right. It is the same trick as everywhere else in this renderer:
replace a quantity you cannot afford to compute with a random choice whose
expected value matches it.

![dielectric scatter: a ray arriving from inside the glass, with the reflected and refracted directions it chooses between](/images/blog/dielectric-scatter.png)

```cpp
__device__ vec3 dielectric_scatter_direction(const vec3& incomingLightDirection,
                                             const vec3& surfaceNormal,
                                             float refraction_cof, curandState* rngState) {
    vec3 unitDirection = incomingLightDirection.normalize();
    float cosTheta = fminf((-unitDirection).dot(surfaceNormal), 1.0f);
    float sinTheta = sqrtf(1.0f - cosTheta * cosTheta);

    bool cannotRefract = (refraction_cof * sinTheta) > 1.0f;
    float reflectProbability;
    if (cannotRefract) {
        reflectProbability = 1.0f;
    } else {
        reflectProbability = schlick_approx(cosTheta, refraction_cof);
    }

    if (curand_uniform(rngState) < reflectProbability) {
        return unitDirection.reflect(surfaceNormal);
    }
    return unitDirection.refract(surfaceNormal, refraction_cof);
}
```

### The hit record had to learn about sides

One more thing had to change before any of this could work. Glass is the first
material where a ray goes *inside* an object, and the sphere intersection was
not ready for that.

It had two problems. It only ever returned the near root of the quadratic, so a
ray starting inside a sphere, which is exactly what a refracted ray is, found
nothing in front of it. And the normal always pointed outward, so a ray leaving
the glass was told the surface faced the wrong way.

```cpp
float nearRoot = distanceToClosestPointOnRay - halfChordLength;
float farRoot  = distanceToClosestPointOnRay + halfChordLength;
float t = nearRoot;
if (t < 0.0001f) t = farRoot;      // if the ray starts from inside
if (t < 0.0001f) return false;

vec3 hitPoint = rayOrigin + rayDirection * t;
outwardNormal = (hitPoint - targetSphere.center).normalize();
frontFace = rayDirection.dot(outwardNormal) < 0.0f;   // is the ray coming from outside
```

The hit record carries that `frontFace` flag now, and flips the normal when the
ray is on the inside. That flag is what the shading switch uses to decide
whether the ratio is `1/ior` or `ior`, which brings me to the part of this log
that cost me the most time.

## Three broken renders

Here is the first image with all three materials in it.

![first render with materials: the glass sphere looks hollow, cut off by a hard crescent, and the mirror has a strange split in it](/images/blog/render-v6-error.jpg)

The mirror is believable. The glass is not. The top half of it has disappeared
into the background and what is left looks like a bowl with a sharp edge, which
is not what glass does.

My first instinct was that the intersection test was broken, since I had just
changed it for the two-root case. It was not. The sphere was being hit exactly
as it should be. There were two separate problems and neither one was where I
was looking.

The first was a genuinely silly bug:

```cpp
} else {
    schlick_approx(cosTheta, refraction_cof);   // result thrown away
}
```

I called the function and did nothing with what it returned.
`reflectProbability` was never assigned in that branch, so the decision between
reflecting and refracting was made by comparing a random number against
whatever happened to be in that stack slot. Not a maths problem, just a line
missing its left hand side, and the compiler had no reason to complain.

The second one is the interesting one, and it is the reason I said earlier to
hold on to that ratio. Look at the two places `refraction_cof` was used. In the
total internal reflection test:

```cpp
bool cannotRefract = (refraction_cof * sinTheta) > 1.0f;   // multiplied
```

and inside `refract()`:

```cpp
float sinTheta2 = sinf(theta1) / refraction_cof;           // divided
```

One of those multiplies by the ratio and the other divides by it. They cannot
both be right. Snell's law, rearranged the way my own figure has it, says
\(\sin\theta_2 = (n_1/n_2)\sin\theta_1\), and `refraction_cof` *is* \(n_1/n_2\),
because that is what the caller builds from `frontFace`. So the test was
correct and the refraction was applying the law upside down.

What I thought I was looking at was a broken sphere. What I was actually looking
at was the right geometry with the refraction formula inverted, which bends rays
by the wrong angle in a way that still looks structured enough to read as a
rendering bug.

![the same scene after fixing the Fresnel probability, still before the ratio was sorted out](/images/blog/render-v7-before-fresnel.jpg)

Then I added the fuzz parameter to conductors, fixed the assignment, and changed
the division to a multiplication in the same commit. And broke it again, in a
new way:

![glass rendered as a black ring, after the total internal reflection test was flipped](/images/blog/render-v9-fuzz-error.jpg)

That black ring is total internal reflection firing when it should not. While
fixing the ratio I had also flipped the comparison:

```cpp
if (sinTheta2 < 1.f) {        // should be > 1.f
    return direction.reflect(surfaceNormal);
}
```

So every ray that *could* refract was being reflected instead, and only the rays
that physically cannot refract were allowed through. The condition is the exact
inverse of the physics. One character, and the material does the opposite of
what it is supposed to.

The fix is the commit called "small fix in refract", which is an understatement
for how long it took to find.

## Where it stands

Here is the same scene with a camera angle that actually shows the glass off.

![the finished render: a glass sphere refracting the ground and sky, a fuzzy metal sphere, and a red diffuse sphere between them](/images/blog/render-v10.jpg)

Much better, right? Look at what is in there now. The glass sphere picks up the
green of the ground and the blue of the sky and bends them, with a bright band
where total internal reflection kicks in along the bottom edge. The metal sphere
on the right is soft rather than sharp, which is the fuzz doing its job. And
none of that is a special case anywhere in the code. It is three branches in one
switch, each returning a direction, and the same bounce loop as before carrying
the attenuation along.

Next time: emissive materials, so the scene can finally contain a light instead
of being lit only by a sky gradient, and then the big one, a BVH built on the
GPU with Morton codes, so the renderer can handle a scene with more than four
spheres in it. That is the part I have been looking forward to since I started.

See you in the next one.
