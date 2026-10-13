FROM node:24-alpine AS web
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS api
WORKDIR /src
COPY backend/SyncSpace.Api/SyncSpace.Api.csproj backend/SyncSpace.Api/
RUN dotnet restore backend/SyncSpace.Api/SyncSpace.Api.csproj
COPY backend/SyncSpace.Api/ backend/SyncSpace.Api/
RUN dotnet publish backend/SyncSpace.Api -c Release -o /app --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=api /app ./
COPY --from=web /src/frontend/dist ./wwwroot
ENV ASPNETCORE_HTTP_PORTS=8080
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "SyncSpace.Api.dll"]
