FROM node:alpine as builder
WORKDIR /opt/app/
COPY package.json ./
RUN npm install
RUN npm prune --production

FROM node:alpine as app
WORKDIR /opt/app
COPY . /opt/app
COPY --from=builder /opt/app/node_modules ./node_modules

ARG NODE_ENV
ENV NODE_ENV $NODE_ENV

CMD [ "npm", "start" ]
