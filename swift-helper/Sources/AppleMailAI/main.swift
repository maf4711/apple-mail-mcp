import Foundation
import FoundationModels

// MARK: - Structured outputs (on-device Apple Intelligence)

@Generable(description: "Mailbox folder name for one email cluster")
struct ClusterName {
    @Guide(description: "Cluster id (domain key), echo exactly")
    var id: String
    @Guide(description: "Short folder name 1-2 words Title Case, no punctuation or colons")
    var mailbox: String
    @Guide(description: "newsletter | personal | finance | shopping | work | notification | other")
    var kind: String
    @Guide(description: "confidence from 0.0 to 1.0")
    var confidence: Double
}

@Generable(description: "Named mailbox categories for multiple email clusters")
struct ClusterNameBatch {
    @Guide(description: "One entry per input cluster")
    var names: [ClusterName]
}

@Generable(description: "Action derived from an email")
struct MailActionGuess {
    @Guide(description: "reply_draft | pay | appointment | review | follow_up | none")
    var kind: String
    @Guide(description: "Short German or English task title")
    var title: String
    @Guide(description: "confidence 0.0-1.0")
    var confidence: Double
}

// MARK: - CLI

enum Command: String {
    case status
    case nameClusters = "name-clusters"
    case classify
    case action
    case help
}

@main
struct AppleMailAI {
    static func main() async {
        let args = Array(CommandLine.arguments.dropFirst())
        let cmdRaw = args.first ?? "help"
        let cmd = Command(rawValue: cmdRaw) ?? .help

        switch cmd {
        case .status:
            await runStatus()
        case .nameClusters:
            await runNameClusters()
        case .classify:
            await runClassify()
        case .action:
            await runAction()
        case .help:
            printHelp()
        }
    }

    static func printHelp() {
        print(
            """
            apple-mail-ai — on-device Apple Intelligence helper for Apple Mail sorting

            Commands:
              status              Model availability (JSON)
              name-clusters       stdin JSON array of clusters → folder names (JSON)
              classify            single domain+subjects JSON → one category (JSON)
              action              single subject+snippet JSON → action guess (JSON)
              help

            name-clusters input (stdin):
              [{"id":"substack.com","domain":"substack.com","count":6,
                "senders":["a@substack.com"],"subjects":["…"]}]

            name-clusters output:
              {"ok":true,"model":"SystemLanguageModel","names":{"substack.com":"Substack"},
               "details":[{"id":"…","mailbox":"…","kind":"newsletter","confidence":0.9}]}

            Env:
              APPLE_MAIL_AI_MAX_CLUSTERS  (default 24)
            """
        )
    }

    // MARK: status

    static func runStatus() async {
        let model = SystemLanguageModel.default
        var payload: [String: Any] = [
            "ok": true,
            "framework": "FoundationModels",
            "model": "SystemLanguageModel.default",
        ]
        switch model.availability {
        case .available:
            payload["availability"] = "available"
            payload["available"] = true
        case .unavailable(let reason):
            payload["availability"] = "unavailable"
            payload["available"] = false
            payload["reason"] = String(describing: reason)
        @unknown default:
            payload["availability"] = "unknown"
            payload["available"] = false
        }
        printJSON(payload)
        if payload["available"] as? Bool != true { exit(2) }
    }

    // MARK: name-clusters

    static func runNameClusters() async {
        guard let input = readStdinData(), !input.isEmpty else {
            fail("empty stdin — expect JSON array of clusters")
            return
        }
        guard let clusters = try? JSONSerialization.jsonObject(with: input) as? [[String: Any]],
              !clusters.isEmpty
        else {
            fail("invalid JSON — expect array of cluster objects")
            return
        }

        let model = SystemLanguageModel.default
        guard case .available = model.availability else {
            fail("SystemLanguageModel unavailable: \(String(describing: model.availability))")
            return
        }

        let maxClusters = Int(ProcessInfo.processInfo.environment["APPLE_MAIL_AI_MAX_CLUSTERS"] ?? "24") ?? 24
        let batch = Array(clusters.prefix(maxClusters))

        let session = LanguageModelSession(
            model: model,
            instructions: """
            You name email folder categories for a personal inbox sorted on a Mac.
            Given clusters (domain + sample subjects/senders), invent a short folder name per cluster.
            Rules:
            - German or English OK; prefer short proper nouns or clear themes (max 2 words).
            - Echo the cluster id exactly in the id field.
            - Never use: Inbox, Sent, Trash, Junk, Drafts, On My Mac.
            - No path separators, no colons, no quotes.
            - kind is one of: newsletter, personal, finance, shopping, work, notification, other.
            """
        )

        let promptBody = compactClustersPrompt(batch)
        do {
            let response = try await session.respond(
                to: "Name these email clusters:\n\(promptBody)",
                generating: ClusterNameBatch.self
            )
            var names: [String: String] = [:]
            var details: [[String: Any]] = []
            for item in response.content.names {
                let id = item.id.trimmingCharacters(in: .whitespacesAndNewlines)
                let box = sanitizeMailbox(item.mailbox)
                guard !id.isEmpty, !box.isEmpty else { continue }
                names[id] = box
                details.append([
                    "id": id,
                    "mailbox": box,
                    "kind": item.kind,
                    "confidence": item.confidence,
                ])
            }
            // Fill missing with domain fallback
            for c in batch {
                guard let id = c["id"] as? String ?? c["domain"] as? String else { continue }
                if names[id] == nil {
                    let domain = (c["domain"] as? String) ?? id
                    names[id] = domainFallback(domain)
                }
            }
            printJSON([
                "ok": true,
                "model": "SystemLanguageModel",
                "usedAppleAI": true,
                "names": names,
                "details": details,
                "count": names.count,
            ])
        } catch {
            fail("generation failed: \(error)")
        }
    }

    // MARK: classify (single)

    static func runClassify() async {
        guard let input = readStdinData(), !input.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: input) as? [String: Any]
        else {
            fail("expect JSON object {domain, subjects[], senders?[]}")
            return
        }
        let domain = (obj["domain"] as? String) ?? ""
        let subjects = (obj["subjects"] as? [String]) ?? []
        let senders = (obj["senders"] as? [String]) ?? []
        let model = SystemLanguageModel.default
        guard case .available = model.availability else {
            fail("SystemLanguageModel unavailable")
            return
        }
        let session = LanguageModelSession(
            model: model,
            instructions: """
            Categorize one email sender into a short mailbox folder name (1-2 words Title Case).
            No punctuation. kind: newsletter|personal|finance|shopping|work|notification|other.
            """
        )
        let prompt = """
        Domain: \(domain)
        Senders: \(senders.prefix(3).joined(separator: "; "))
        Subjects:
        \(subjects.prefix(5).map { "- \($0)" }.joined(separator: "\n"))
        """
        do {
            let response = try await session.respond(to: prompt, generating: ClusterName.self)
            printJSON([
                "ok": true,
                "model": "SystemLanguageModel",
                "id": response.content.id.isEmpty ? domain : response.content.id,
                "mailbox": sanitizeMailbox(response.content.mailbox),
                "kind": response.content.kind,
                "confidence": response.content.confidence,
            ])
        } catch {
            fail("generation failed: \(error)")
        }
    }

    // MARK: action

    static func runAction() async {
        guard let input = readStdinData(), !input.isEmpty,
              let obj = try? JSONSerialization.jsonObject(with: input) as? [String: Any]
        else {
            fail("expect JSON {subject, snippet?, from?}")
            return
        }
        let subject = (obj["subject"] as? String) ?? ""
        let snippet = (obj["snippet"] as? String) ?? ""
        let from = (obj["from"] as? String) ?? ""
        let model = SystemLanguageModel.default
        guard case .available = model.availability else {
            fail("SystemLanguageModel unavailable")
            return
        }
        let session = LanguageModelSession(
            model: model,
            instructions: """
            Decide if this email needs a follow-up action for the recipient.
            kind must be one of: reply_draft, pay, appointment, review, follow_up, none.
            Prefer none for newsletters and pure notifications.
            title is a short task label (German OK).
            """
        )
        let prompt = "From: \(from)\nSubject: \(subject)\nBody snippet: \(snippet.prefix(800))"
        do {
            let response = try await session.respond(to: prompt, generating: MailActionGuess.self)
            printJSON([
                "ok": true,
                "model": "SystemLanguageModel",
                "kind": response.content.kind,
                "title": response.content.title,
                "confidence": response.content.confidence,
            ])
        } catch {
            fail("generation failed: \(error)")
        }
    }

    // MARK: helpers

    static func compactClustersPrompt(_ clusters: [[String: Any]]) -> String {
        var lines: [String] = []
        for c in clusters {
            let id = (c["id"] as? String) ?? (c["domain"] as? String) ?? "?"
            let domain = (c["domain"] as? String) ?? id
            let count = c["count"] as? Int ?? 0
            let subjects = (c["subjects"] as? [String]) ?? []
            let senders = (c["senders"] as? [String]) ?? []
            lines.append(
                """
                - id=\(id) domain=\(domain) count=\(count)
                  senders: \(senders.prefix(2).joined(separator: ", "))
                  subjects: \(subjects.prefix(4).joined(separator: " | "))
                """
            )
        }
        return lines.joined(separator: "\n")
    }

    static func sanitizeMailbox(_ raw: String) -> String {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // strip path / quote / punctuation junk (keep letters, digits, spaces, hyphen)
        s = s.replacingOccurrences(of: #"[^A-Za-z0-9ÄÖÜäöüß \-]"#, with: "", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: CharacterSet(charactersIn: "- "))
        if s.count > 40 { s = String(s.prefix(40)).trimmingCharacters(in: .whitespaces) }
        let blocked: Set<String> = ["inbox", "sent", "trash", "junk", "drafts", "on my mac", "all mail"]
        if blocked.contains(s.lowercased()) { return "" }
        return s
    }

    static func domainFallback(_ domain: String) -> String {
        let host = domain.lowercased().replacingOccurrences(of: #"^www\."#, with: "", options: .regularExpression)
        let base = host.split(separator: ".").dropLast().last.map(String.init) ?? host
        guard !base.isEmpty else { return "Mail" }
        return base.prefix(1).uppercased() + base.dropFirst()
    }

    static func readStdinData() -> Data? {
        if #available(macOS 10.15.4, *) {
            // Read all of stdin
        }
        let handle = FileHandle.standardInput
        let data = handle.readDataToEndOfFile()
        return data.isEmpty ? nil : data
    }

    static func printJSON(_ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]),
              let s = String(data: data, encoding: .utf8)
        else {
            print("{\"ok\":false,\"error\":\"json encode failed\"}")
            return
        }
        print(s)
    }

    static func fail(_ message: String) {
        printJSON(["ok": false, "error": message])
        exit(1)
    }
}
