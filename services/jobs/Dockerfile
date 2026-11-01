# syntax=docker/dockerfile:1
# Sathi.Jobs (Hangfire server + admin dashboard) — build context: repository root
#   docker build -f services/jobs/Dockerfile -t sathi-jobs .

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1

COPY services/api/Directory.Build.props services/api/Directory.Packages.props services/api/
COPY services/jobs/Directory.Build.props services/jobs/Directory.Packages.props services/jobs/
COPY services/api/src/Sathi.Core/Sathi.Core.csproj services/api/src/Sathi.Core/
COPY services/jobs/Sathi.Jobs/Sathi.Jobs.csproj services/jobs/Sathi.Jobs/
RUN dotnet restore services/jobs/Sathi.Jobs/Sathi.Jobs.csproj

COPY services/api/src/Sathi.Core/ services/api/src/Sathi.Core/
COPY services/jobs/Sathi.Jobs/ services/jobs/Sathi.Jobs/
RUN dotnet publish services/jobs/Sathi.Jobs/Sathi.Jobs.csproj -c Release -o /app/publish --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends curl libgssapi-krb5-2 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV ASPNETCORE_HTTP_PORTS=8080 \
    ASPNETCORE_ENVIRONMENT=Production \
    DOTNET_RUNNING_IN_CONTAINER=true
COPY --from=build /app/publish .
USER $APP_UID
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 CMD curl -fsS http://localhost:8080/health/live || exit 1
ENTRYPOINT ["dotnet", "Sathi.Jobs.dll"]
