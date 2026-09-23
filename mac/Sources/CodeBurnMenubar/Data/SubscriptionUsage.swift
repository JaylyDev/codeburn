import Foundation

struct SubscriptionUsage: Sendable, Equatable {
    enum Tier: String, Sendable, Equatable {
        case pro
        case max5x
        case max20x
        case team
        case teamPremium
        case enterprise
        case enterprisePremium
        case unknown

        var displayName: String {
            switch self {
            case .pro: "Pro"
            case .max5x: "Max 5x"
            case .max20x: "Max 20x"
            case .team: "Team"
            case .teamPremium: "Team Premium"
            case .enterprise: "Enterprise"
            case .enterprisePremium: "Enterprise Premium"
            case .unknown: "Subscription"
            }
        }
    }

    /// A model-scoped weekly limit from the `limits` array (e.g. the Fable
    /// bucket). The label is the API's `scope.model.display_name`, so new
    /// model buckets show up without a client update.
    struct ScopedWindow: Sendable, Equatable {
        let label: String
        let percent: Double
        let resetsAt: Date?
    }

    let tier: Tier
    let rawTier: String?
    let fiveHourPercent: Double?
    let fiveHourResetsAt: Date?
    let sevenDayPercent: Double?
    let sevenDayResetsAt: Date?
    let sevenDayOpusPercent: Double?
    let sevenDayOpusResetsAt: Date?
    let sevenDaySonnetPercent: Double?
    let sevenDaySonnetResetsAt: Date?
    let scopedWeekly: [ScopedWindow]
    let fetchedAt: Date

    static func tier(from raw: String?) -> Tier {
        tier(subscriptionType: nil, rateLimitTier: raw)
    }

    static func tier(subscriptionType: String?, rateLimitTier: String?) -> Tier {
        let subscriptionType = subscriptionType?.lowercased() ?? ""
        let rateLimitTier = rateLimitTier?.lowercased() ?? ""
        let hasMax20 = rateLimitTier.contains("max_20x") || rateLimitTier.contains("max20x") || rateLimitTier.contains("max-20x")
        let hasMax = rateLimitTier.contains("max")
        if subscriptionType == "team" || (subscriptionType.isEmpty && rateLimitTier.contains("team")) {
            return hasMax ? .teamPremium : .team
        }
        if subscriptionType == "enterprise" || (subscriptionType.isEmpty && rateLimitTier.contains("enterprise")) {
            return hasMax ? .enterprisePremium : .enterprise
        }
        if subscriptionType == "max" || hasMax {
            return hasMax20 ? .max20x : .max5x
        }
        if subscriptionType == "pro" || rateLimitTier.contains("pro") {
            return .pro
        }
        return .unknown
    }
}
