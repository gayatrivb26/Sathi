using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace Sathi.Core.Data;

/// <summary>Used by `dotnet ef migrations add` only (no database connection is opened).</summary>
public sealed class DesignTimeDbContextFactory : IDesignTimeDbContextFactory<AppDbContext>
{
    public AppDbContext CreateDbContext(string[] args)
    {
        var conn = Environment.GetEnvironmentVariable("ConnectionStrings__App")
                   ?? "Host=localhost;Port=5432;Database=sathi;Username=sathi_app;Password=design-time";
        var builder = new DbContextOptionsBuilder<AppDbContext>();
        builder.UseSathiNpgsql(conn);
        return new AppDbContext(builder.Options);
    }
}
