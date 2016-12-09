FROM busybox:latest
MAINTAINER Menci <huanghaorui301@gmail.com>
RUN adduser sandbox -u 1111 -h /sandbox -D
COPY sandbox /usr/sbin/
CMD while true; do sleep 1; done
