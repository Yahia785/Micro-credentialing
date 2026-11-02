FROM public.ecr.aws/lambda/nodejs:22

# g++ for compiling student code. The launcher is built with the same compiler and is the only
# setuid-free helper that applies resource limits and the Landlock file policy.
RUN dnf install -y gcc-c++ && dnf clean all && rm -rf /var/cache/dnf

COPY launcher.c /tmp/launcher.c
RUN gcc -O2 -Wall -o /usr/local/bin/sandbox-launcher /tmp/launcher.c && rm /tmp/launcher.c

COPY index.js ${LAMBDA_TASK_ROOT}/
COPY lib ${LAMBDA_TASK_ROOT}/lib

CMD ["index.handler"]
