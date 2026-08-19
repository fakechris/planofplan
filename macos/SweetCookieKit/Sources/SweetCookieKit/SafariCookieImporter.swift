#if os(macOS)
import Foundation

/// Reads cookies from Safari's `Cookies.binarycookies` file (macOS).
///
/// This is a best-effort parser for the documented `binarycookies` format:
/// file header is big-endian; cookie pages and records are little-endian.
enum SafariCookieImporter {
    enum ImportError: LocalizedError {
        case cookieFileNotFound
        case cookieFileNotReadable(path: String)
        case invalidFile

        var errorDescription: String? {
            switch self {
            case .cookieFileNotFound: "Safari cookie file not found."
            case let .cookieFileNotReadable(path):
                "Safari cookie file exists but is not readable (\(path)). Enable Full Disk Access."
            case .invalidFile: "Safari cookie file is invalid."
            }
        }
    }

    struct CookieRecord {
        let domain: String
        let name: String
        let path: String
        let value: String
        let expires: Date?
        let isSecure: Bool
        let isHTTPOnly: Bool
    }

    static func availableStores(homeDirectories: [URL]) -> [BrowserCookieStore] {
        var stores: [BrowserCookieStore] = []
        var seenIDs = Set<String>()

        for url in self.candidateCookieFiles(homeDirectories: homeDirectories) {
            guard FileManager.default.fileExists(atPath: url.path) else { continue }
            let descriptor = self.storeDescriptor(for: url)
            var storeID = descriptor.id
            if !seenIDs.insert(storeID).inserted {
                storeID = "\(descriptor.id):\(url.path)"
                _ = seenIDs.insert(storeID)
            }

            stores.append(BrowserCookieStore(
                browser: .safari,
                profile: BrowserProfile(id: storeID, name: descriptor.name),
                kind: .safari,
                label: descriptor.label,
                databaseURL: url))
        }

        if stores.isEmpty {
            return [self.defaultStore()]
        }
        return stores
    }

    static func loadCookies(
        from store: BrowserCookieStore,
        matchingDomains domains: [String],
        domainMatch: BrowserCookieDomainMatch,
        homeDirectories: [URL],
        logger: ((String) -> Void)? = nil) throws -> [CookieRecord]
    {
        guard store.browser == .safari else {
            throw ImportError.invalidFile
        }
        guard let databaseURL = store.databaseURL else {
            return try self.loadCookies(
                matchingDomains: domains,
                domainMatch: domainMatch,
                homeDirectories: homeDirectories,
                logger: logger)
        }
        return try self.loadCookies(
            from: databaseURL,
            matchingDomains: domains,
            domainMatch: domainMatch,
            logger: logger)
    }

    static func loadCookies(
        matchingDomains domains: [String],
        domainMatch: BrowserCookieDomainMatch,
        homeDirectories: [URL],
        logger: ((String) -> Void)? = nil) throws -> [CookieRecord]
    {
        let candidates = self.candidateCookieFiles(homeDirectories: homeDirectories)
        var lastNoPermission: String?
        var lastReadError: String?

        for url in candidates {
            do {
                let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue
                logger?("Safari cookies: trying \(url.path) (\(size ?? -1) bytes)")
                let data = try Data(contentsOf: url)
                let records = try Self.parseBinaryCookies(data: data)
                return records.filter { record in
                    BrowserCookieDomainMatcher.matches(
                        domain: record.domain,
                        patterns: domains,
                        match: domainMatch)
                }
            } catch let error as CocoaError where error.code == .fileReadNoPermission {
                lastNoPermission = url.path
                logger?("Safari cookies: permission denied for \(url.path)")
                continue
            } catch {
                lastReadError = "\(url.path): \(error.localizedDescription)"
                logger?("Safari cookies: failed to read \(url.path): \(error.localizedDescription)")
                continue
            }
        }

        if let lastNoPermission {
            throw ImportError.cookieFileNotReadable(path: lastNoPermission)
        }
        if let lastReadError {
            logger?("Safari cookies: last error: \(lastReadError)")
        }
        throw ImportError.cookieFileNotFound
    }

    private static func loadCookies(
        from url: URL,
        matchingDomains domains: [String],
        domainMatch: BrowserCookieDomainMatch,
        logger: ((String) -> Void)? = nil) throws -> [CookieRecord]
    {
        do {
            let size = (try? FileManager.default.attributesOfItem(atPath: url.path)[.size] as? NSNumber)?.intValue
            logger?("Safari cookies: trying \(url.path) (\(size ?? -1) bytes)")
            let data = try Data(contentsOf: url)
            let records = try Self.parseBinaryCookies(data: data)
            return records.filter { record in
                BrowserCookieDomainMatcher.matches(
                    domain: record.domain,
                    patterns: domains,
                    match: domainMatch)
            }
        } catch let error as CocoaError where error.code == .fileReadNoPermission {
            logger?("Safari cookies: permission denied for \(url.path)")
            throw ImportError.cookieFileNotReadable(path: url.path)
        } catch let error as CocoaError where error.code == .fileReadNoSuchFile {
            logger?("Safari cookies: missing \(url.path)")
            throw ImportError.cookieFileNotFound
        } catch let error as ImportError {
            throw error
        } catch {
            logger?("Safari cookies: failed to read \(url.path): \(error.localizedDescription)")
            throw error
        }
    }

    // MARK: - BinaryCookies parsing

    private static func parseBinaryCookies(data: Data) throws -> [CookieRecord] {
        let reader = DataReader(data)
        guard reader.readASCII(count: 4) == "cook" else { throw ImportError.invalidFile }
        guard let rawPageCount = reader.readUInt32BE() else { throw ImportError.invalidFile }
        let pageCount = Int(rawPageCount)
        guard pageCount <= reader.remaining / MemoryLayout<UInt32>.size else {
            throw ImportError.invalidFile
        }

        var pageSizes: [Int] = []
        pageSizes.reserveCapacity(pageCount)
        for _ in 0..<pageCount {
            guard let rawSize = reader.readUInt32BE() else { throw ImportError.invalidFile }
            pageSizes.append(Int(rawSize))
        }

        var records: [CookieRecord] = []
        var offset = reader.offset
        for size in pageSizes {
            guard size >= 8, size <= data.count - offset else { throw ImportError.invalidFile }
            let pageData = data.subdata(in: offset..<(offset + size))
            try records.append(contentsOf: Self.parsePage(data: pageData))
            offset += size
        }
        return records
    }

    private static func parsePage(data: Data) throws -> [CookieRecord] {
        let r = DataReader(data)
        guard r.readUInt32LE() != nil, // page header
              let rawCookieCount = r.readUInt32LE()
        else { throw ImportError.invalidFile }
        let cookieCount = Int(rawCookieCount)
        if cookieCount == 0 { return [] }
        guard cookieCount <= r.remaining / MemoryLayout<UInt32>.size else {
            throw ImportError.invalidFile
        }

        var cookieOffsets: [Int] = []
        cookieOffsets.reserveCapacity(cookieCount)
        for _ in 0..<cookieCount {
            guard let rawOffset = r.readUInt32LE() else { throw ImportError.invalidFile }
            cookieOffsets.append(Int(rawOffset))
        }

        return cookieOffsets.compactMap { offset in
            guard offset <= data.count - 56 else { return nil }
            return Self.parseCookieRecord(data: data, offset: offset)
        }
    }

    private static func parseCookieRecord(data: Data, offset: Int) -> CookieRecord? {
        let r = DataReader(data, offset: offset)
        guard let rawSize = r.readUInt32LE() else { return nil }
        let size = Int(rawSize)
        guard size >= 56, size <= data.count - offset else { return nil }

        guard r.readUInt32LE() != nil, // unknown
              let flags = r.readUInt32LE(),
              r.readUInt32LE() != nil, // unknown
              let rawURLOffset = r.readUInt32LE(),
              let rawNameOffset = r.readUInt32LE(),
              let rawPathOffset = r.readUInt32LE(),
              let rawValueOffset = r.readUInt32LE(),
              r.readUInt32LE() != nil, // commentOffset
              r.readUInt32LE() != nil, // commentURL
              let expiresRef = r.readDoubleLE(),
              r.readDoubleLE() != nil // creation
        else { return nil }

        let limit = offset + size
        let domain = Self.readCString(
            data: data,
            base: offset,
            relativeOffset: Int(rawURLOffset),
            limit: limit) ?? ""
        let name = Self.readCString(
            data: data,
            base: offset,
            relativeOffset: Int(rawNameOffset),
            limit: limit) ?? ""
        let path = Self.readCString(
            data: data,
            base: offset,
            relativeOffset: Int(rawPathOffset),
            limit: limit) ?? "/"
        let value = Self.readCString(
            data: data,
            base: offset,
            relativeOffset: Int(rawValueOffset),
            limit: limit) ?? ""

        if domain.isEmpty || name.isEmpty { return nil }

        let isSecure = (flags & 0x1) != 0
        let isHTTPOnly = (flags & 0x4) != 0
        let expires = expiresRef > 0 ? Date(timeIntervalSinceReferenceDate: expiresRef) : nil

        return CookieRecord(
            domain: Self.normalizeDomain(domain),
            name: name,
            path: path,
            value: value,
            expires: expires,
            isSecure: isSecure,
            isHTTPOnly: isHTTPOnly)
    }

    private static func readCString(data: Data, base: Int, relativeOffset: Int, limit: Int) -> String? {
        guard base <= limit, limit <= data.count, relativeOffset < limit - base else { return nil }
        let start = base + relativeOffset
        let end = data[start..<limit].firstIndex(of: 0) ?? limit
        guard end > start else { return nil }
        return String(data: data.subdata(in: start..<end), encoding: .utf8)
    }

    private static func normalizeDomain(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.hasPrefix(".") { return String(trimmed.dropFirst()) }
        return trimmed
    }

    private static func candidateCookieFiles(homeDirectories: [URL]) -> [URL] {
        let homes = self.candidateHomes(from: homeDirectories)
        var urls: [URL] = []
        urls.reserveCapacity(homes.count * 4)
        for home in homes {
            urls.append(home.appendingPathComponent("Library/Cookies/Cookies.binarycookies"))
            urls.append(
                home.appendingPathComponent(
                    "Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies"))
            urls.append(contentsOf: self.websiteDataStoreCookieFiles(in: home))
        }
        var seen = Set<String>()
        return urls.filter { url in
            let path = url.path
            guard !seen.contains(path) else { return false }
            seen.insert(path)
            return true
        }
    }

    private static func websiteDataStoreCookieFiles(in home: URL) -> [URL] {
        let roots = [
            home.appendingPathComponent("Library/Containers/com.apple.Safari/Data/Library/WebKit/WebsiteDataStore"),
            home.appendingPathComponent("Library/WebKit/WebsiteDataStore"),
        ]

        return roots.flatMap { root in
            self.cookieFiles(in: root)
        }
    }

    private static func cookieFiles(in root: URL) -> [URL] {
        guard FileManager.default.fileExists(atPath: root.path),
              let enumerator = FileManager.default.enumerator(
                  at: root,
                  includingPropertiesForKeys: [.isRegularFileKey],
                  options: [.skipsHiddenFiles, .skipsPackageDescendants])
        else {
            return []
        }

        var files: [URL] = []
        for case let url as URL in enumerator {
            guard url.lastPathComponent == "Cookies.binarycookies" else { continue }
            let values = try? url.resourceValues(forKeys: [.isRegularFileKey])
            guard values?.isRegularFile != false else { continue }
            files.append(url)
        }
        return files
    }

    private static func candidateHomes(from homeDirectories: [URL]) -> [URL] {
        var seen = Set<String>()
        return homeDirectories.filter { home in
            let path = home.path
            guard !seen.contains(path) else { return false }
            seen.insert(path)
            return true
        }
    }

    private static func defaultStore() -> BrowserCookieStore {
        BrowserCookieStore(
            browser: .safari,
            profile: BrowserProfile(id: "safari.default", name: "Default"),
            kind: .safari,
            label: "Safari",
            databaseURL: nil)
    }

    private static func storeDescriptor(for url: URL) -> (id: String, name: String, label: String) {
        let components = url.pathComponents
        if let index = components.firstIndex(of: "WebsiteDataStore"),
           index + 1 < components.count
        {
            let token = components[index + 1]
            return (
                id: "safari.datastore.\(token)",
                name: token,
                label: "Safari (\(token))")
        }

        let path = url.path
        if path.contains("/Library/Containers/com.apple.Safari/Data/Library/Cookies/") {
            return (id: "safari.default", name: "Default", label: "Safari")
        }
        if path.contains("/Library/Cookies/") {
            return (id: "safari.legacy", name: "Legacy", label: "Safari (Legacy)")
        }

        let name = url.deletingLastPathComponent().lastPathComponent
        return (id: "safari.\(name)", name: name, label: "Safari (\(name))")
    }
}

// MARK: - DataReader

private final class DataReader {
    let data: Data
    private(set) var offset: Int

    init(_ data: Data, offset: Int = 0) {
        self.data = data
        self.offset = offset
    }

    func readASCII(count: Int) -> String? {
        guard let d = self.read(count) else { return nil }
        return String(data: d, encoding: .ascii)
    }

    var remaining: Int {
        self.data.count - self.offset
    }

    func read(_ count: Int) -> Data? {
        guard count >= 0, count <= self.remaining else { return nil }
        let end = self.offset + count
        let slice = self.data[self.offset..<end]
        self.offset = end
        return Data(slice)
    }

    func readUInt32BE() -> UInt32? {
        guard let d = self.read(MemoryLayout<UInt32>.size) else { return nil }
        return d.reduce(0) { ($0 << 8) | UInt32($1) }
    }

    func readUInt32LE() -> UInt32? {
        guard let d = self.read(MemoryLayout<UInt32>.size) else { return nil }
        return d.enumerated().reduce(0) { value, element in
            value | (UInt32(element.element) << UInt32(element.offset * 8))
        }
    }

    func readDoubleLE() -> Double? {
        guard let d = self.read(MemoryLayout<UInt64>.size) else { return nil }
        let raw = d.enumerated().reduce(UInt64(0)) { value, element in
            value | (UInt64(element.element) << UInt64(element.offset * 8))
        }
        return Double(bitPattern: raw)
    }
}

#endif
