# Stage 1: build the launcher. The compiler used here never reaches the final image through this stage.
FROM public.ecr.aws/lambda/nodejs:22 AS launcher
RUN dnf install -y --setopt=install_weak_deps=0 --nodocs gcc \
 && dnf clean all && rm -rf /var/cache/dnf /var/lib/dnf/history* /var/log/dnf*
COPY launcher.c /tmp/launcher.c
RUN gcc -O2 -Wall -o /sandbox-launcher /tmp/launcher.c

# Stage 2: the runtime image. g++ for compiling student code, plus only the launcher binary from stage 1
# (setrlimit, Landlock, subreaper). No weak dependencies and no docs; the package cache is cleaned in the same
# RUN step so it is not kept in a layer.
FROM public.ecr.aws/lambda/nodejs:22
RUN dnf install -y --setopt=install_weak_deps=0 --nodocs gcc-c++ \
 && dnf clean all && rm -rf /var/cache/dnf /var/lib/dnf/history* /var/log/dnf*
COPY --from=launcher /sandbox-launcher /usr/local/bin/sandbox-launcher

COPY index.js ${LAMBDA_TASK_ROOT}/
COPY lib ${LAMBDA_TASK_ROOT}/lib

CMD ["index.handler"]
