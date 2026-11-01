using MailKit.Net.Smtp;
using MailKit.Security;
using Microsoft.Extensions.Options;
using MimeKit;
using Sathi.Core.Options;

namespace Sathi.Core.Email;

public sealed record EmailMessage(string To, string Subject, string TextBody, string? HtmlBody = null);

public interface IAppEmailSender
{
    Task SendAsync(EmailMessage message, CancellationToken ct);
}

/// <summary>SMTP via MailKit (Mailpit locally, real SMTP in production).</summary>
public sealed class SmtpEmailSender(IOptions<EmailOptions> options) : IAppEmailSender
{
    private readonly EmailOptions _options = options.Value;

    public async Task SendAsync(EmailMessage message, CancellationToken ct)
    {
        var mime = new MimeMessage();
        mime.From.Add(MailboxAddress.Parse(_options.From));
        mime.To.Add(MailboxAddress.Parse(message.To));
        mime.Subject = message.Subject;
        var body = new BodyBuilder { TextBody = message.TextBody, HtmlBody = message.HtmlBody };
        mime.Body = body.ToMessageBody();

        using var client = new SmtpClient { Timeout = 15000 };
        var secure = _options.Port == 465 ? SecureSocketOptions.SslOnConnect : SecureSocketOptions.StartTlsWhenAvailable;
        await client.ConnectAsync(_options.Host, _options.Port, secure, ct);
        if (!string.IsNullOrEmpty(_options.User))
            await client.AuthenticateAsync(_options.User, _options.Password ?? "", ct);
        await client.SendAsync(mime, ct);
        await client.DisconnectAsync(true, ct);
    }
}

public static class EmailTemplates
{
    public static EmailMessage VerifyEmail(string to, string displayName, string link) => new(
        to,
        "Verify your email for Sathi",
        $"Hi {displayName},\n\nWelcome to Sathi! Confirm your email address by opening this link:\n\n{link}\n\nIf you didn't create an account, you can ignore this email.",
        $"<p>Hi {System.Net.WebUtility.HtmlEncode(displayName)},</p><p>Welcome to Sathi! Confirm your email address:</p><p><a href=\"{link}\">Verify my email</a></p><p>If you didn't create an account, you can ignore this email.</p>");

    public static EmailMessage ResetPassword(string to, string displayName, string link) => new(
        to,
        "Reset your Sathi password",
        $"Hi {displayName},\n\nReset your password by opening this link:\n\n{link}\n\nIf you didn't ask for this, you can ignore this email.",
        $"<p>Hi {System.Net.WebUtility.HtmlEncode(displayName)},</p><p><a href=\"{link}\">Reset my password</a></p><p>If you didn't ask for this, you can ignore this email.</p>");

    private static string H(string s) => System.Net.WebUtility.HtmlEncode(s);

    public static EmailMessage ClassInvite(string to, string className, string courseTitle, string instructorName, string link, DateTime expiresAt) => new(
        to,
        $"You're invited to join {className} on Sathi",
        $"Hi,\n\n{instructorName} has invited you to join the class \"{className}\" for the course \"{courseTitle}\" on Sathi.\n\nAccept the invitation here (sign in or create an account with this email address):\n\n{link}\n\nThe invitation expires on {expiresAt:yyyy-MM-dd}.",
        $"<p>Hi,</p><p>{H(instructorName)} has invited you to join the class <strong>{H(className)}</strong> for the course <strong>{H(courseTitle)}</strong> on Sathi.</p><p><a href=\"{link}\">Accept the invitation</a></p><p>Sign in or create an account with this email address. The invitation expires on {expiresAt:yyyy-MM-dd}.</p>");

    public static EmailMessage StaffInvite(string to, string role, string? courseTitle, string link, DateTime expiresAt) => new(
        to,
        $"You're invited to Sathi as {(role == "Admin" ? "an administrator" : "an instructor")}",
        $"Hi,\n\nYou've been invited to Sathi as {(role == "Admin" ? "an administrator" : "an instructor")}{(courseTitle is null ? "" : $" for the course \"{courseTitle}\"")}.\n\nCreate your account with this email address here:\n\n{link}\n\nAlready have an account? Sign in with this email address first, then open the link. The invitation expires on {expiresAt:yyyy-MM-dd}.",
        $"<p>Hi,</p><p>You've been invited to Sathi as {(role == "Admin" ? "an administrator" : "an instructor")}{(courseTitle is null ? "" : $" for the course <strong>{H(courseTitle)}</strong>")}.</p><p><a href=\"{link}\">Accept the invitation</a></p><p>Already have an account? Sign in with this email address first, then open the link. The invitation expires on {expiresAt:yyyy-MM-dd}.</p>");

    public static EmailMessage GuardianConsentRequest(string to, string learnerName, string learnerEmailMasked, string link, DateTime expiresAt) => new(
        to,
        $"Please review {learnerName}'s Sathi account",
        $"Hello,\n\n{learnerName} ({learnerEmailMasked}) has signed up for Sathi, an AI study tutor, and gave your email address as their parent or guardian.\n\nBecause they are under 18, we need your consent before they can use Sathi. Review what we process and give or decline consent here:\n\n{link}\n\nThe link expires on {expiresAt:yyyy-MM-dd}. If you decline, or do nothing, the account will not be activated. Sathi has no advertising or behavioural tracking.",
        $"<p>Hello,</p><p>{H(learnerName)} ({H(learnerEmailMasked)}) has signed up for Sathi, an AI study tutor, and gave your email address as their parent or guardian.</p><p>Because they are under 18, we need your consent before they can use Sathi.</p><p><a href=\"{link}\">Review and decide</a></p><p>The link expires on {expiresAt:yyyy-MM-dd}. If you decline, or do nothing, the account will not be activated. Sathi has no advertising or behavioural tracking.</p>");

    public static EmailMessage GuardianConsentGranted(string to, string learnerName, string link) => new(
        to,
        $"Thank you — {learnerName} can now use Sathi",
        $"Hello,\n\nThank you for giving consent for {learnerName} to use Sathi.\n\nYou can withdraw consent at any time using this link; the account and its data will then be deleted:\n\n{link}",
        $"<p>Hello,</p><p>Thank you for giving consent for {H(learnerName)} to use Sathi.</p><p>You can withdraw consent at any time; the account and its data will then be deleted:</p><p><a href=\"{link}\">Manage consent</a></p>");

    public static EmailMessage RevisionReminder(string to, string displayName, int dueCount, string link) => new(
        to,
        $"{dueCount} revision card{(dueCount == 1 ? "" : "s")} due today",
        $"Hi {displayName},\n\nYou have {dueCount} revision card{(dueCount == 1 ? "" : "s")} due. It takes about {Math.Max(1, (int)Math.Ceiling(dueCount * 1.2))} minutes:\n\n{link}\n\nYou can turn reminders off in your settings.",
        $"<p>Hi {System.Net.WebUtility.HtmlEncode(displayName)},</p><p>You have <strong>{dueCount}</strong> revision card{(dueCount == 1 ? "" : "s")} due.</p><p><a href=\"{link}\">Start revising</a></p><p>You can turn reminders off in your settings.</p>");
}
