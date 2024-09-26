FROM node:12 as contracts

WORKDIR /mono
COPY ./contracts /contracts-whole
RUN mkdir contracts
RUN mv contracts-whole/package.json contracts
RUN mv contracts-whole/package-lock.json contracts
RUN npm install --only=prod
RUN mv contracts-whole/truffle-config.js contracts
RUN mv contracts-whole/contracts/* contracts/
#COPY ./contracts/package.json ./contracts/package-lock.json /contracts/

# WORKDIR /mono/contracts
# RUN npm install --only=prod

#COPY ./contracts /contracts-whole
#COPY ./contracts/truffle-config.js ./
#RUN mv /mono/contracts-whole/truffle-config.js /mono/contracts
#RUN mv /contracts-whole/truffle-config.js /mono/contracts
#RUN mv /mono/contracts-whole/contracts /mono/contracts
RUN rm -rf /contracts-whole
RUN npm run compile

FROM node:12

RUN rm -f sources.list
RUN echo "deb [trusted=yes] http://archive.debian.org/debian stretch main non-free contrib" > /etc/apt/sources.list
RUN echo "deb-src [trusted=yes] http://archive.debian.org/debian stretch main non-free contrib" >> /etc/apt/sources.list
RUN echo "deb [trusted=yes] http://archive.debian.org/debian-security stretch/updates main non-free contrib" >> /etc/apt/sources.list

RUN apt-get update && \
    apt-get install -y build-essential libc6-dev wget && \
    apt-get clean

WORKDIR /mono
COPY package.json .
COPY --from=contracts /mono/contracts/build ./contracts/build
COPY commons/package.json ./commons/
COPY oracle/package.json ./oracle/
COPY yarn.lock .
RUN NOYARNPOSTINSTALL=1 yarn install --frozen-lockfile --production --ignore-engines

COPY ./commons ./commons
COPY ./oracle ./oracle

WORKDIR /mono/oracle
CMD echo "To start a bridge process run:" \
  "ORACLE_VALIDATOR_ADDRESS=<validator address> ORACLE_VALIDATOR_ADDRESS_PRIVATE_KEY=<validator address private key> docker-compose up -d --build"