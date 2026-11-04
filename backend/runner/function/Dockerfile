# Stage 1: build the launcher and the diagnose probe. The compiler used here never reaches the final image through this stage.
FROM public.ecr.aws/lambda/nodejs:22 AS launcher
RUN dnf install -y --setopt=install_weak_deps=0 --nodocs gcc \
 && dnf clean all && rm -rf /var/cache/dnf /var/lib/dnf/history* /var/log/dnf*
COPY launcher.c probe.c bootstrap.c sandbox_filter.h /tmp/
RUN gcc -O2 -Wall -o /sandbox-launcher /tmp/launcher.c  && gcc -O2 -Wall -o /sandbox-probe /tmp/probe.c \
 && gcc -O2 -Wall -o /runner-bootstrap /tmp/bootstrap.c

# Stage 2: the runtime image. g++ for compiling student code, plus only the launcher and probe binaries from stage 1
# (setrlimit, Landlock, subreaper). No weak dependencies and no docs; the package cache is cleaned in the same
# RUN step so it is not kept in a layer.
FROM public.ecr.aws/lambda/nodejs:22
RUN dnf install -y --setopt=install_weak_deps=0 --nodocs gcc-c++ \
 && dnf clean all && rm -rf /var/cache/dnf /var/lib/dnf/history* /var/log/dnf*
COPY --from=launcher /sandbox-launcher /usr/local/bin/sandbox-launcher
COPY --from=launcher /sandbox-probe /usr/local/bin/sandbox-probe

COPY --from=launcher /runner-bootstrap /usr/local/bin/runner-bootstrap

COPY index.js once.js ${LAMBDA_TASK_ROOT}/
COPY lib ${LAMBDA_TASK_ROOT}/lib

# Custom runtime: the ENTRYPOINT is the bootstrap that Lambda talks to; it starts one fresh `node once.js` per invocation.
# (Locally: docker run --entrypoint /usr/local/bin/aws-lambda-rie <image> /usr/local/bin/runner-bootstrap)
ENTRYPOINT ["/usr/local/bin/runner-bootstrap"]
